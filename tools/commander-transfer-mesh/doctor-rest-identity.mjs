// Validate Syncthing's authenticated local REST identity without child processes.
export function verifySyncthingDaemon(status,version,expectedId){
 if(typeof expectedId!=='string'||!/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(expectedId))
  throw new Error('Expected device ID invalid');
 if(!status||status.myID!==expectedId)throw new Error('Daemon identity mismatch');
 const release=version?.version;
 if(typeof release!=='string'||!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(release))
  throw new Error('Daemon version invalid');
 return 'syncthing '+release;
}
