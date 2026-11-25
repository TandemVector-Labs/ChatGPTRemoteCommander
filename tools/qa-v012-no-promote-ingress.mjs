#!/usr/bin/env node
/**
 * Deliberately narrow NoPromote G1 negative-only acceptance.
 * A protected development candidate may pass boot/quarantine preflight while
 * refusing all anonymous/forged legacy MCP. This is NOT user authentication,
 * tool execution, J01 permission, Stable or installed rollout acceptance.
 */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {probeInstalledG1,parsePortArgs} from './v1-01/installed-g1-readonly-probe.mjs';

export function qualifyNoPromoteQuarantine(result) {
  const denied=result?.observations;
  if(!denied||denied.health?.status!==200||
     denied.legacyAnonymous?.status!==403||
     denied.legacyForged?.status!==403)
    throw Error('V012_NOPROMOTE_LEGACY_QUARANTINE_NOT_PROVED');
  const v2Absent=result.status==='BLOCKED' &&
    result.code==='V2_AUTHENTICATED_INGRESS_ABSENT' &&
    denied.v2Anonymous?.status===404 && denied.v2Forged?.status===404 &&
    denied.metadata?.status===404;
  const v2Negative=result.status==='NEGATIVE_PREFLIGHT_PASS' &&
    result.code==='ANONYMOUS_AND_FORGED_DENIAL_ONLY' &&
    denied.v2Anonymous?.status===403 && denied.v2Forged?.status===403 &&
    denied.metadata?.status===200;
  // On the actual 0.12 privileged Core, quarantine precedes route dispatch,
  // so even missing V2 metadata and /mcp-v2 return the same 403 denial.
  // This is strictly a negative-only NoPromote preflight, not OAuth readiness.
  const globallyQuarantined=result.status==='BLOCKED' &&
    result.code==='V2_RESOURCE_METADATA_UNVERIFIED' &&
    denied.v2Anonymous?.status===403 && denied.v2Forged?.status===403 &&
    denied.metadata?.status===403;
  if(!v2Absent&&!v2Negative&&!globallyQuarantined)
    throw Error('V012_NOPROMOTE_G1_NEGATIVE_ADMISSION_UNVERIFIED');
  return Object.freeze({
    status:'V012_NOPROMOTE_NEGATIVE_ONLY_PASS',
    legacyAnonymousDenied:true,
    legacyForgedDenied:true,
    protectedV2State:v2Absent?'NOT_WIRED':(globallyQuarantined?'ALL_ROUTES_QUARANTINED':'NEGATIVE_DENIAL_ONLY'),
    positiveG1Proved:false,
    ownerJ01Proved:false,
    privilegedExecutionProved:false,
    publicReleaseApproved:false,
    activeRouteChanged:false
  });
}

export async function main(args=process.argv.slice(2)){
 try {
   const port=parsePortArgs(args);
   const observed=await probeInstalledG1(port);
   const result=qualifyNoPromoteQuarantine(observed);
   process.stdout.write(JSON.stringify({port,...result})+'\n');
   return 0;
 }catch(e){
   console.error('V012_NOPROMOTE_NEGATIVE_GATE_BLOCKED '+String(e?.message??e));
   return 3;
 }
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
 process.exitCode=await main();
