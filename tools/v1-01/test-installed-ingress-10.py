#!/usr/bin/env python3
"""V1-01 expanded 10-case installed security observations (both Standard and Full).
No live router edits, credentials, user-file reads, or GUI access. Requires Python 3.10+.
"""
import argparse, hashlib, http.client, json, os, pathlib, secrets, shutil, socket, subprocess, tempfile, time
from pathlib import Path

def sha(path):
    with path.open('rb') as f:
        h=hashlib.sha256()
        for chunk in iter(lambda:f.read(1048576),b''): h.update(chunk)
    return h.hexdigest()

def request(port, method, path, body=None, headers=None):
    c=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
    try:
        c.request(method,path,body=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json', **(headers or {})});r=c.getresponse();d=r.read(65537)
        if len(d)>65536: raise RuntimeError('oversized observation')
        try: value=json.loads(d)
        except ValueError: value={}
        return r.status,value
    finally: c.close()

def matched(rpc, rid, marker):
    if not isinstance(rpc,dict) or rpc.get('id')!=rid or rpc.get('jsonrpc')!='2.0': return False
    v=rpc.get('result')
    if not isinstance(v,dict) or v.get('isError') or rpc.get('error'):return False
    items=[v.get('structuredContent')]
    for i in v.get('content',[]):
        if isinstance(i,dict) and isinstance(i.get('text'),str):
            try:items.append(json.loads(i['text']))
            except ValueError:pass
    return any(isinstance(x,dict) and x.get('isFile') is True and x.get('size')==marker.stat().st_size and os.path.normcase(str(x.get('path')))==os.path.normcase(str(marker)) for x in items)

def trial(root, home, flag, mode):
    cfg=json.loads((root/'state/profiles/default.json').read_bytes())
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    cfg['host']='127.0.0.1';cfg['port']=port
    if flag!='absent': cfg['requireTrustedIngress']=flag
    config=home/'probe-config.json';raw=(json.dumps(cfg)+'\n').encode();config.write_bytes(raw)
    marker=root/'app'/('marker-'+secrets.token_hex(8));marker.write_bytes(bytes(secrets.randbelow(4096)+555)); os.chmod(marker,0o600)
    # --run uses the package's own binary; equivalent program entry with a scratch-only config so no live listener is reused.
    node=root/'bin/node' if os.name!='nt' else Path(shutil.which('node') or 'missing');assert node.is_file()
    env={k:v for k,v in os.environ.items() if not k.startswith('REMOTE_COMMANDER_')};env.update(HOME=str(home),USERPROFILE=str(home),LOCALAPPDATA=str(home),APPDATA=str(home),XDG_STATE_HOME=str(home/'state'),XDG_DATA_HOME=str(home/'data'),REMOTE_COMMANDER_CONFIG=str(config),REMOTE_COMMANDER_CAPABILITY_GAP_DIR=str(home/'gaps'))
    status={};rows=[];start=time.monotonic()
    with (home/'listener.log').open('wb') as log:
        proc=subprocess.Popen([str(node),str(root/'app/src/server-v0.3.mjs')],cwd=root/'app',env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            while time.monotonic()-start<18 and proc.poll() is None:
                try:
                    code,status=request(port,'GET','/health');
                    if code==200 and status.get('configSha256')==hashlib.sha256(raw).hexdigest():break
                except (OSError,ValueError,http.client.HTTPException):pass
                time.sleep(.12)
            if status.get('configSha256')!=hashlib.sha256(raw).hexdigest() or proc.poll() is not None: raise RuntimeError('no exact listener identity')
            for forged in [False,True]:
                rid=secrets.randbelow(900000)+10000;params={'name':'file_info','arguments':{'path':str(marker)}}
                if forged:params['_meta']={'openai/session':'untrusted-fixture-chat'}
                code,body=request(port,'POST','/mcp',{'jsonrpc':'2.0','id':rid,'method':'tools/call','params':params},{'Authorization':'Bearer invalid-qa-marker'} if forged else {})
                rows.append({'variant':'invalid-bearer-and-chat' if forged else 'anonymous','status':code,'match':matched(body,rid,marker),'denied':code==403 and body=={'error':'trusted_transport_required'}})
        finally:
            if proc.poll() is None:proc.terminate()
            try:proc.wait(5)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(5)
            marker.unlink()
    observed=status.get('privilegedLegacyHttpQuarantined')
    return {'mode':mode,'flag':flag,'healthQuarantine':observed,'invocations':rows,
            'observationComplete':len(rows)==2}

def main():
    p=argparse.ArgumentParser();p.add_argument('--installer',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--baseline',action='store_true');a=p.parse_args();exe=a.installer.resolve(strict=True);assert sha(exe)==a.sha256,'installer hash mismatch';out=[]
    with tempfile.TemporaryDirectory(prefix='commander-ingress-qa-',dir=Path.home()) as scratch:
        w=Path(scratch); modes=['full'] if a.baseline else ['standard','full']
        for mode in modes:
            root=w/mode; install=subprocess.run([str(exe),'--install','--target',str(root),'--mode',mode],capture_output=True,timeout=80);assert install.returncode==0,'private install failed'
            for ix,flag in enumerate([True] if a.baseline else ['absent',False,True,None,'false']):
                home=w/(mode+str(ix));home.mkdir(mode=0o700);out.append(trial(root,home,flag,mode))
    print(json.dumps({'matrixVersion':2,'observationsOnly':True,'installerSha256':a.sha256,
                      'cases':out,'productionChanged':False,'realOAuthProved':False},separators=(',',':')),flush=True)
    return 0 if len(out)==10 and all(x['observationComplete'] for x in out) else 3
if __name__=='__main__': raise SystemExit(main())
