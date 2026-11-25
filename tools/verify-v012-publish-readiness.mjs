import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Release admission must not infer fleet approval from a tag or a CI artifact.
const REQUIRED_ACCEPTANCE = [
 'sourceTests','securityScan','allProductBuilds','authAndGui',
 'multiUserPermissions','stableInstallRoots','rollback',
 'fiveHostsRuntime','signingOrApprovedProvenance'
];
const REQUIRED_COMPONENTS = [
 'core','browser-commander','control-center','transfer-mesh',
 'workflow-project-engine','local-ai-workers','gui-same-owner',
 'multi-user-access','updater-installer'
];

export function verifyV012Publication(version,tag,manifest) {
 const deny=()=>{throw Error('V108_V012_RELEASE_APPROVAL_DENIED');};
 if(version!=='0.12.0'||tag!=='v0.12.0')deny();
 if(!manifest||manifest.schema!=='rc-suite-release-train-v1'||
    manifest.train!=='0.12'||manifest.sourceVersion!==version||
    manifest.targetPrerelease!=='0.12.0'||
    manifest.firstStable!=='0.12.0'||manifest.majorTarget!=='1.0.0'||
    manifest.status!=='RELEASE_APPROVED'||
    manifest.channel!=='release'||manifest.isStable!==true||
    manifest.publishApproved!==true||
    manifest.autoupdateApproved!==true||
    manifest.installedPromotionApproved!==true||
    manifest.releaseTag!==tag||
    !/^[0-9a-f]{40}$/.test(manifest.sourceBaseSha||''))deny();
 if(!Array.isArray(manifest.components)||
    manifest.components.length<REQUIRED_COMPONENTS.length)deny();
 const ids=new Set();
 for(const component of manifest.components){
   if(!component||typeof component.id!=='string'||ids.has(component.id)||
     component.required!==true||component.verified!==true)deny();
   ids.add(component.id);
 }
 if(REQUIRED_COMPONENTS.some(id=>!ids.has(id)))deny();
 if(!manifest.acceptance||typeof manifest.acceptance!=='object'||
    Array.isArray(manifest.acceptance))deny();
 if(REQUIRED_ACCEPTANCE.some(id=>manifest.acceptance[id]!==true)||
    Object.values(manifest.acceptance).some(value=>value!==true))deny();
 if(!Array.isArray(manifest.fleet)||manifest.fleet.length<5||
    new Set(manifest.fleet).size!==manifest.fleet.length)deny();
 // Historical fiveHostsRuntime alone is insufficient for all known Commander 1 connectors.
 const coverage=manifest.fleetCoverage;
 if(!coverage||coverage.scope!=='all-known-commander1-connectors'||
    coverage.mappingVerified!==true||
    coverage.bootLoginAndRollbackVerified!==true||
    !Array.isArray(coverage.expectedHostIds)||coverage.expectedHostIds.length<8||
    !Array.isArray(coverage.acceptedHostIds)||
    new Set(coverage.expectedHostIds).size!==coverage.expectedHostIds.length||
    new Set(coverage.acceptedHostIds).size!==coverage.acceptedHostIds.length||
    coverage.expectedHostIds.some(id=>typeof id!=='string'||!id.trim())||
    coverage.acceptedHostIds.some(id=>typeof id!=='string')||
    coverage.acceptedHostIds.length!==coverage.expectedHostIds.length||
    coverage.expectedHostIds.some(id=>!coverage.acceptedHostIds.includes(id)))deny();
 if(manifest.distribution?.noPublicStableAccepted!==false||
    manifest.distribution?.keepAssetsAndTags!==true||
    manifest.distribution?.oldReleasesHistorical!==true)deny();
 return 'V108_V012_RELEASE_APPROVED_MANIFEST_PASS';
}

export function summarizeV012Readiness(manifest) {
 if(!manifest || manifest.train!=='0.12') throw Error('V108_V012_INVALID_READINESS_MANIFEST');
 const components=Array.isArray(manifest.components)?manifest.components:[];
 const byId=new Map(components.filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
 const missingComponents=REQUIRED_COMPONENTS.filter(id=>byId.get(id)?.verified!==true);
 const acceptance=manifest.acceptance&&typeof manifest.acceptance==='object'&&!Array.isArray(manifest.acceptance)
   ? manifest.acceptance : {};
 const missingAcceptance=REQUIRED_ACCEPTANCE.filter(id=>acceptance[id]!==true);
 const scope=manifest.fleetCoverage||{};
 const expected=Array.isArray(scope.expectedHostIds)?scope.expectedHostIds:[];
 const accepted=Array.isArray(scope.acceptedHostIds)?scope.acceptedHostIds:[];
 const missingHosts=expected.filter(id=>!accepted.includes(id));
 let eligibleByManifest=false;
 try{verifyV012Publication('0.12.0','v0.12.0',manifest);eligibleByManifest=true;}catch{}
 return {
  schema:'rc-v012-readiness-report-v1',targetVersion:'0.12.0',
  sourceVersion:manifest.sourceVersion??null,manifestEligibilityOnly:eligibleByManifest,
  releasePromoted:manifest.isStable===true&&manifest.publishApproved===true,
  requiredComponents:REQUIRED_COMPONENTS.length,verifiedComponents:REQUIRED_COMPONENTS.length-missingComponents.length,
  missingComponents,
  requiredAcceptance:REQUIRED_ACCEPTANCE.length,verifiedAcceptance:REQUIRED_ACCEPTANCE.length-missingAcceptance.length,
  missingAcceptance,
  expectedHostCount:expected.length,acceptedHostCount:accepted.filter(id=>expected.includes(id)).length,
  missingHosts,
  mappingVerified:scope.mappingVerified===true,
  bootLoginAndRollbackVerified:scope.bootLoginAndRollbackVerified===true,
  externalEvidenceRequired:true,
  note:'Manifest eligibility is not independent proof of host identity, signature, installed artifacts, or owner approval.'
 };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
   if(process.argv.length===3 && process.argv[2]==='--report') {
     const manifest=JSON.parse(readFileSync('docs/release-train-0.12.json','utf8'));
     console.log(JSON.stringify(summarizeV012Readiness(manifest)));
     process.exit(0);
   }
   if(process.argv.length!==4)throw Error('EXPECTED_VERSION_AND_TAG');
   const [version,tag]=process.argv.slice(2);
   const manifest=JSON.parse(readFileSync('docs/release-train-0.12.json','utf8'));
   console.log(verifyV012Publication(version,tag,manifest));
 }catch{
   console.error('V108_V012_PUBLICATION_DENIED');
   process.exitCode=2;
 }
}
