// V1-06 source-only trusted publication seam. This is NOT an MCP entrypoint.
// The embedding Host MUST independently validate the cryptographic original
// execution receipt against its durable operation record, exact arguments,
// issuer, owner consent epoch and originating ChatGPT identity. This module
// never trusts caller-supplied correlation, identity, binding or signatures.
import {createHash} from 'node:crypto';
import {stableJson,trustedWorkflowScope} from './delivery-store.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA=/^[a-f0-9]{64}$/;
const EPOCH=/^[a-f0-9]{32,64}$/;
const TYPES=new Set(['tool','operation','project']);
const KINDS=new Set([
  'COMPLETED','FAILED','UNCERTAIN','WAITING_INPUT',
  'BLOCKED','EXHAUSTED','CANCELLED','PAUSED'
]);
const FIELDS=[
  'verified','source','receiptId','eventDigest','hostId','principalId',
  'profileId','conversationId','correlationId','bindingId','inputHash','sourceId',
  'originAdmissionId','workerId','workerKeyId','workerGrantRevision'
];
const data=value=>value!==null&&typeof value==='object'
  &&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const value=(record,key)=>{
  const property=Object.getOwnPropertyDescriptor(record,key);
  if(!property||!property.enumerable||!Object.hasOwn(property,'value'))
    fail('DELIVERY_ORIGIN_RECEIPT_INVALID');
  return property.value;
};
const hash=record=>createHash('sha256').update(stableJson(record)).digest('hex');
function expectedOriginal(input){
  if(!data(input)||Reflect.ownKeys(input).length!==(Object.hasOwn(input,'workflowScope')?4:3)
    ||!Reflect.ownKeys(input).every(k=>['correlationId','inputHash','originAdmissionId','workflowScope'].includes(k)))
    fail('DELIVERY_ORIGIN_EXPECTED_CONTEXT_REQUIRED');
  const inputHash=value(input,'inputHash');
  const correlationId=value(input,'correlationId');
  const originAdmissionId=value(input,'originAdmissionId');
  if(typeof originAdmissionId!=='string'||!ID.test(originAdmissionId))
    fail('DELIVERY_ORIGIN_EXPECTED_CONTEXT_REQUIRED');
  if(typeof inputHash!=='string'||!SHA.test(inputHash)
    ||typeof correlationId!=='string'||!ID.test(correlationId))
    fail('DELIVERY_ORIGIN_EXPECTED_CONTEXT_REQUIRED');
  return Object.freeze({inputHash,correlationId,originAdmissionId,
    ...(Object.hasOwn(input,'workflowScope')
      ? {workflowScope:trustedWorkflowScope(value(input,'workflowScope'))}: {})});
}
function safeEvent(input){
  if(!data(input))fail('DELIVERY_ORIGIN_EVENT_INVALID');
  const permitted=new Set(['eventKey','source','sourceId','kind','code','artifact','receiptId']);
  if(Reflect.ownKeys(input).some(k=>typeof k!=='string'||!permitted.has(k)))
    fail('DELIVERY_ORIGIN_EVENT_INVALID');
  const eventKey=value(input,'eventKey');
  const source=value(input,'source');
  const sourceId=value(input,'sourceId');
  const kind=value(input,'kind');
  const receiptId=value(input,'receiptId');
  const code=Object.hasOwn(input,'code')?value(input,'code'):kind;
  const artifact=Object.hasOwn(input,'artifact')?value(input,'artifact'):null;
  if(![eventKey,sourceId,code,receiptId].every(s=>typeof s==='string'&&ID.test(s))
    ||!TYPES.has(source)||!KINDS.has(kind))
    fail('DELIVERY_ORIGIN_EVENT_INVALID');
  let cleanArtifact=null;
  if(artifact!==null){
    if(!data(artifact)||Reflect.ownKeys(artifact).some(k=>!['id','sha256','bytes'].includes(k)))
      fail('DELIVERY_ORIGIN_EVENT_INVALID');
    const id=value(artifact,'id'),sha256=value(artifact,'sha256'),bytes=value(artifact,'bytes');
    if(typeof id!=='string'||!SHA.test(id)||id!==sha256
      ||!Number.isSafeInteger(bytes)||bytes<0||bytes>16*1024*1024)
      fail('DELIVERY_ORIGIN_EVENT_INVALID');
    cleanArtifact=Object.freeze({id,sha256,bytes});
  }
  const event=Object.freeze({eventKey,source,sourceId,kind,code,artifact:cleanArtifact});
  return {event,receiptId,eventDigest:hash(event)};
}
function trustedReceipt(input,request){
  if(!data(input)||FIELDS.some(field=>!Object.hasOwn(input,field))
    ||Reflect.ownKeys(input).some(k=>!FIELDS.includes(k)&&k!=='workflowScope'))
    fail('DELIVERY_ORIGIN_RECEIPT_INVALID');
  const proof=Object.fromEntries(FIELDS.map(k=>[k,value(input,k)]));
  if(Object.hasOwn(input,'workflowScope'))
    proof.workflowScope=trustedWorkflowScope(value(input,'workflowScope'));
  if(proof.verified!==true||proof.source!=='HOST_SIGNED_ORIGINAL_EXECUTION'
    ||proof.receiptId!==request.receiptId
    ||proof.eventDigest!==request.eventDigest
    ||proof.sourceId!==request.sourceId
    ||typeof proof.inputHash!=='string'||!SHA.test(proof.inputHash)
    ||typeof proof.originAdmissionId!=='string'||!ID.test(proof.originAdmissionId)
    ||typeof proof.bindingId!=='string'||!EPOCH.test(proof.bindingId)
     ||typeof proof.workerId!=='string'||!/^cw_[a-f0-9]{64}$/.test(proof.workerId)
     ||typeof proof.workerKeyId!=='string'||!SHA.test(proof.workerKeyId)
     ||!Number.isSafeInteger(proof.workerGrantRevision)||proof.workerGrantRevision<1
    ||['hostId','principalId','profileId','conversationId','correlationId']
      .some(k=>typeof proof[k]!=='string'||!ID.test(proof[k])))
    fail('DELIVERY_ORIGIN_RECEIPT_MISMATCH');
  return Object.freeze(proof);
}

/**
 * Only instantiate in a host-authenticated internal boundary. verifyExecutionReceipt
 * is a trusted native callback, NOT an MCP input and NOT a generic "verified: true"
 * object supplied by the model. It must independently validate the exact signed
 * eventDigest, original command inputHash, owner/chat consent epoch and receipt ID.
 *
 * An original result may be recorded after a grant expires/revokes; the consumer
 * still refuses to display or ACK it under any different consent epoch.
 */
export function createTrustedDeliveryOriginPublisher({store,verifyExecutionReceipt}={}){
  if(!store||typeof store.publish!=='function'||typeof verifyExecutionReceipt!=='function')
    fail('DELIVERY_ORIGIN_TRUSTED_HOST_REQUIRED');
  return Object.freeze({
    async publish(input,expected){
      // The trusted operation dispatcher supplies original inputHash and route
      // independently of the signed receipt verifier. This prevents a valid
      // receipt for a different operation or chat from being re-attached here.
      const original=expectedOriginal(expected);
      const {event,receiptId,eventDigest}=safeEvent(input);
      const request=Object.freeze({receiptId,eventDigest,sourceId:event.sourceId});
      const proof=trustedReceipt(await verifyExecutionReceipt(request),request);
      if(proof.inputHash!==original.inputHash
        ||proof.correlationId!==original.correlationId
        ||proof.originAdmissionId!==original.originAdmissionId
        ||Object.hasOwn(proof,'workflowScope')!==Object.hasOwn(original,'workflowScope')
        ||(Object.hasOwn(original,'workflowScope')
          &&stableJson(proof.workflowScope)!==stableJson(original.workflowScope)))
        fail('DELIVERY_ORIGIN_OPERATION_MISMATCH');
      // All values reach storage exclusively from the immutable event snapshot
      // and independently verified original Host receipt, never MCP arguments.
      const signedLineage=Object.fromEntries([
        'receiptId','eventDigest','hostId','principalId','profileId',
        'conversationId','correlationId','bindingId','inputHash','sourceId','originAdmissionId','workerId','workerKeyId','workerGrantRevision'
      ].map(key=>[key,proof[key]]));
      if(Object.hasOwn(proof,'workflowScope'))signedLineage.workflowScope=proof.workflowScope;
      const originReceiptHash=hash(signedLineage);
      return store.publish({...event,correlationId:proof.correlationId,
        bindingId:proof.bindingId,originReceiptHash,workerIdentity:Object.freeze({
          workerId:proof.workerId,workerKeyId:proof.workerKeyId,
          workerGrantRevision:proof.workerGrantRevision
        }),...(Object.hasOwn(proof,'workflowScope')
          ? {workflowScope:proof.workflowScope}: {})});
    }
  });
}
