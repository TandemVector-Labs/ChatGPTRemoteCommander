// Reads a short-lived local QA Keycloak discovery receipt only.
// It never requests a token and must not be interpreted as owner authorization.
import fs from 'node:fs';
import path from 'node:path';
import {validateV2OAuthProvider} from '../src/v2-oauth-provider-preflight.mjs';
const root=path.join(process.env.LOCALAPPDATA??'', 'ChatGPTRemoteCommander',
  'qa','identity-provider','.rc012-temporary-realm-tls');
const expected=path.join(root,'metadata.json');
if(process.argv.length!==3||!path.isAbsolute(process.argv[2])
  ||path.resolve(process.argv[2]).toLowerCase()!==expected.toLowerCase())
  throw Error('RC012_LOCAL_QA_METADATA_SOURCE_REQUIRED');
const stat=fs.lstatSync(expected);
if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)
  throw Error('RC012_LOCAL_QA_METADATA_FILE_INVALID');
const metadata=JSON.parse(fs.readFileSync(expected,'utf8'));
const issuer='https://qa-issuer.example/realms/commander-v012';
const resource='https://qa-mcp.example/mcp';
const r=validateV2OAuthProvider({issuer,resource,metadata,
  requiredScopes:['commander.workflow'],
  clientRegistration:'pre-registered',tokenType:'JWT'});
console.log(JSON.stringify({
  pinnedIssuer:r.issuer===issuer,pinnedResource:r.audience===resource,
  scopes:r.scopes,
  pkceMetadataEligible:true,
  trustedTokenIssued:false,
  ownerAuthorized:false,
  g1AuthenticatedChat:r.claimOfAuthenticatedChat
}));
