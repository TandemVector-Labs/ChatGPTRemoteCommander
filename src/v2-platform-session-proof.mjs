import {isProxy} from 'node:util/types';

const SESSION=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};

function exactRecord(value,fields,code){
  if(!value||typeof value!=='object'||Array.isArray(value)||isProxy(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail(code);
  const keys=Reflect.ownKeys(value);
  if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)))
    fail(code);
  const out=Object.create(null);
  for(const key of fields){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||descriptor.enumerable!==true)
      fail(code);
    out[key]=descriptor.value;
  }
  return out;
}

/**
 * In-process capability for the exact transport proof created by the trusted
 * V2 HTTP ingress after direct OpenAI mTLS or pinned private tunnel-client
 * mTLS and native process verification. A JSON clone,
 * model argument, request header or caller-created object cannot reproduce
 * WeakMap identity. Consumption is one-shot.
 */
export function createV2PlatformSessionProofAuthority(){
  const issued=new WeakMap();

  function issue(value){
    const record=exactRecord(value,
      ['peerType','sessionSource','sessionHandle','tokenSha256'],
      'V2_PLATFORM_SESSION_PROOF_INVALID');
    if(!['openai-chatgpt-mtls','openai-tunnel-client-mtls'].includes(record.peerType)
      ||record.sessionSource!=='openai/session'
      ||typeof record.sessionHandle!=='string'
      ||!SESSION.test(record.sessionHandle)
      ||record.sessionHandle.startsWith('mcp-')
      ||typeof record.tokenSha256!=='string'||!HASH.test(record.tokenSha256))
      fail('V2_PLATFORM_SESSION_PROOF_INVALID');
    const proof=Object.freeze(Object.create(null));
    issued.set(proof,Object.freeze(record));
    return proof;
  }

  function inspect(proof){
    if(!proof||typeof proof!=='object'||Array.isArray(proof)||isProxy(proof))
      return null;
    return issued.get(proof)??null;
  }

  function consume(proof){
    const record=inspect(proof);
    if(!record)fail('V2_PLATFORM_SESSION_PROOF_REQUIRED');
    issued.delete(proof);
    return Object.freeze({
      source:'native-platform-session',
      sessionHandle:record.sessionHandle,
      tokenSha256:record.tokenSha256
    });
  }

  return Object.freeze({issue,inspect,consume});
}
