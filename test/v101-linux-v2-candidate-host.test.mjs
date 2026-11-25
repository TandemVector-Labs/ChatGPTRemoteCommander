import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLinuxV101V2CandidateHost} from '../src/v101-linux-owner-security-bootstrap.mjs';

const route=Object.freeze({
  hostId:'linux-host',profileId:'emad',principalId:'owner-1',
  conversationId:'chat-1',operationId:'workflow-step',
  target:Object.freeze({kind:'workflow-root',id:'root-a'})
});

test('Linux V1-01 candidate host composes owner grants, proof admission and direct mTLS without opening a listener',{skip:process.platform!=='linux'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-linux-v2-host-'));
  let nativeCalls=0;
  const host=createLinuxV101V2CandidateHost({
    directory:path.join(root,'grants'),
    resource:'https://commander.example.invalid/mcp-v2',
    authorizationServers:['https://idp.example.invalid'],
    certificatePem:'-----BEGIN CERTIFICATE-----\nsynthetic-host-certificate\n-----END CERTIFICATE-----',
    privateKeyPem:'-----BEGIN PRIVATE KEY-----\nsynthetic-host-private-key\n-----END PRIVATE KEY-----',
    hostId:'linux-host',profileId:'emad',
    issuer:'https://idp.example.invalid',
    audience:'https://commander.example.invalid/mcp-v2',
    verifyAccessToken:async()=>null,
    resolvePrincipal:async()=>null,
    resolveOwnerRoute:async sessionHandle=>sessionHandle==='chat-1'?route:null,
    authorizeExactInvocation:async()=>false,
    createTrustedDispatcher:async()=>({}),
    ownerSessionOptions:{
      execFileImpl:()=>{nativeCalls++;throw new Error('must not probe or prompt during bootstrap');}
    }
  });
  try{
    assert.equal(host.gateway.requiredTransport,'direct-openai-mtls');
    assert.equal(host.gateway.protectedResource.metadataUrl,
      'https://commander.example.invalid/.well-known/oauth-protected-resource/mcp-v2');
    assert.equal(typeof host.createUnboundTlsServer,'function');
    assert.equal(host.grantRegistry.readWorkerGrant({
      hostId:'linux-host',profileId:'emad',principalId:'owner-1',
      conversationId:'chat-1',bindingId:'a'.repeat(64),
      workerId:'cw_'+'b'.repeat(64),keyId:'c'.repeat(64),
      ownerSidHash:'d'.repeat(64),deviceProvider:'native-key-store',
      deviceIdHash:'e'.repeat(64),tunnelProvider:'openai-secure-mcp-tunnel',
      tunnelIdHash:'f'.repeat(64),capabilityPolicyDigest:'1'.repeat(64)
    }),null);
    assert.equal(nativeCalls,0);
  }finally{
    host.close();
    host.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('Linux V1-01 candidate host rejects issuer/resource/scope mismatches',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-linux-v2-host-policy-'));
  const common={
    directory:path.join(root,'grants'),
    resource:'https://commander.example.invalid/mcp-v2',
    authorizationServers:['https://idp.example.invalid'],
    certificatePem:'-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----',
    privateKeyPem:'-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
    hostId:'linux-host',profileId:'emad',issuer:'https://idp.example.invalid',
    audience:'https://commander.example.invalid/mcp-v2',
    verifyAccessToken:async()=>null,resolvePrincipal:async()=>null,
    resolveOwnerRoute:async()=>route,authorizeExactInvocation:async()=>false,
    createTrustedDispatcher:async()=>({})
  };
  try{
    assert.throws(()=>createLinuxV101V2CandidateHost({...common,audience:'https://other.example.invalid'}),/V101_LINUX_V2_HOST_BOOTSTRAP_REQUIRED/);
    assert.throws(()=>createLinuxV101V2CandidateHost({...common,issuer:'https://other-idp.example.invalid'}),/V101_LINUX_V2_HOST_BOOTSTRAP_REQUIRED/);
    assert.throws(()=>createLinuxV101V2CandidateHost({...common,scopes:['read_only']}),/V101_LINUX_V2_HOST_BOOTSTRAP_REQUIRED/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Linux V1-01 candidate host rejects missing trusted OAuth/route/dispatcher dependencies',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v101-linux-v2-host-invalid-'));
  try{
    assert.throws(()=>createLinuxV101V2CandidateHost({
      directory:path.join(root,'grants')
    }),/V101_LINUX_V2_HOST_BOOTSTRAP_REQUIRED/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
