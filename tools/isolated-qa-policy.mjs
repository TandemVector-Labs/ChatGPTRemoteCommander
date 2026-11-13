import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
// Admission to isolated CI only, never a release-approval authority.
export function qualifyIsolatedQa(version,manifest){
 if(['0.10.24','0.10.25','0.10.26'].includes(version))return 'HISTORICAL_QA';
 if(typeof version!=='string'||!/^0\.11\.0-dev\.[1-9][0-9]*$/.test(version))throw Error('RC011_QA_INVALID_VERSION');
 if(!manifest||manifest.schema!=='rc-suite-release-train-v1'||manifest.train!=='0.11'||
   manifest.sourceVersion!==version||manifest.status!=='INTEGRATION_CANDIDATE_NOT_FINAL'||
   manifest.channel!=='development'||manifest.isStable!==false||
   manifest.publishApproved!==false||manifest.autoupdateApproved!==false||
   manifest.installedPromotionApproved!==false||manifest.releaseTag!==null||
   manifest.distribution?.noPublicStableAccepted!==true||
   !Array.isArray(manifest.components)||manifest.components.length<8||
   !manifest.components.every(c=>c?.required===true&&c.verified===false)||
   !manifest.acceptance||typeof manifest.acceptance!=='object'||
   !Object.keys(manifest.acceptance).length||
   !Object.values(manifest.acceptance).every(x=>x===false))throw Error('RC011_QA_POLICY_DENIED');
 return 'DEVELOPMENT_NOPROMOTE_QA';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==2)throw Error('ARGUMENTS_NOT_ALLOWED');
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const v=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
  const m=JSON.parse(readFileSync(path.join(root,'docs/release-train-0.11.json'),'utf8'));
  console.log('RC011_'+qualifyIsolatedQa(v,m)+'_VERSION_ADMITTED_ONLY');
 }catch{console.error('RC011_QA_SOURCE_NOT_ADMITTED');process.exitCode=2}
}
