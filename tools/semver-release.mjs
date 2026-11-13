// Bounded, prerelease-aware comparison shared by Windows/Linux native updaters.
// This does not grant publish, promotion or rollback permission.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const format=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|rc)\.([1-9]\d*))?$/;
export function parseReleaseVersion(input){
 if(typeof input!=='string'||input.length>96)throw new Error('RC_VERSION_INVALID');
 const match=format.exec(input);
 if(!match)throw new Error('RC_VERSION_INVALID');
 return {major:BigInt(match[1]),minor:BigInt(match[2]),patch:BigInt(match[3]),
  phase:match[4]||'stable',revision:match[5]?BigInt(match[5]):0n};
}
export function compareReleaseVersions(left,right){
 const a=parseReleaseVersion(left),b=parseReleaseVersion(right);
 for(const field of ['major','minor','patch']){
  if(a[field]!==b[field])return a[field]>b[field]?1:-1;
 }
 const rank={dev:1,rc:2,stable:3};
 if(rank[a.phase]!==rank[b.phase])return rank[a.phase]>rank[b.phase]?1:-1;
 if(a.revision!==b.revision)return a.revision>b.revision?1:-1;
 return 0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==5||process.argv[2]!=='compare')throw Error('RC_VERSION_BAD_CLI');
  const result=compareReleaseVersions(process.argv[3],process.argv[4]);
  process.stdout.write(result>0?'gt\n':result<0?'lt\n':'eq\n');
 }catch{process.stderr.write('RC_VERSION_COMPARE_INVALID\n');process.exitCode=2;}
}
