// Reject linked/junction ancestors, including a caller-selected root itself.
// A preflight cannot eliminate filesystem races; callers must retain exclusive
// creation and private directory permissions when mutating managed state.
import fs from 'node:fs';
import path from 'node:path';
export function assertUnredirectedDirectoryAncestors(input,code='MANAGED_PATH_UNSAFE'){
 if(typeof input!=='string'||!path.isAbsolute(input))throw Error(code);
 const normalized=path.normalize(input);
 // An absolute Windows path may still refer to a network or device namespace.
 // Operator state must be on a local drive, not a UNC/device namespace.
 if(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(normalized))throw Error(code);
 const anchor=path.parse(normalized).root;
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
