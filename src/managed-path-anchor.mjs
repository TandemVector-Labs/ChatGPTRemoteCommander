// Reject linked/junction ancestors, including a caller-selected root itself.
// A preflight cannot eliminate filesystem races; callers must retain exclusive
// creation and private directory permissions when mutating managed state.
import fs from 'node:fs';
import path from 'node:path';
export function assertUnredirectedDirectoryAncestors(input,code='MANAGED_PATH_UNSAFE'){
 if(typeof input!=='string'||!path.isAbsolute(input))throw Error(code);
 const normalized=path.normalize(input),anchor=path.parse(normalized).root;
 let cur=anchor;
 for(const part of path.relative(anchor,normalized).split(path.sep)){
  if(!part||part==='.')continue;
  cur=path.join(cur,part);
  try{
   const s=fs.lstatSync(cur);
   if(s.isSymbolicLink()||!s.isDirectory())throw Error(code);
  }catch(e){if(e.code==='ENOENT')continue;throw Error(code);}
 }
}
