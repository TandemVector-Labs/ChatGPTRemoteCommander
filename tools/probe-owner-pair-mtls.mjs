// Local owner-pair transport smoke. Reads only the already staged private
// certificates, binds an ephemeral loopback TLS port, and exits. Never runs a
// tunnel-client daemon, modifies plugins or logs certificate/private key bytes.
import https from 'node:https';
import fs from 'node:fs';
import {execFile as execFileCallback} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const validPath=p=>typeof p==='string'&&path.isAbsolute(p)
  &&!p.includes('\0')&&!p.startsWith('\\\\');
async function main(){
  const args=process.argv.slice(2);
  if((args.length!==1&&args.length!==2)||!validPath(args[0])
    ||(args.length===2&&!validPath(args[1])))
    fail('RC012_MTLS_PROBE_OWNER_DIRECTORY_REQUIRED');
  const directory=fs.realpathSync.native(args[0]);
  const home=fs.realpathSync.native(os.homedir());
  const rel=path.relative(home,directory);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))
    fail('RC012_MTLS_PROBE_OUTSIDE_OWNER_HOME');
  const certs={};
  for(const name of ['ca.crt','server.crt','server.key','client.crt','client.key']){
    const filename=path.join(directory,name);
    const stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536||stat.size<128)
      fail('RC012_MTLS_PROBE_UNSAFE_FILE');
    if(process.platform!=='win32'&&(stat.mode&0o077)!==0)
      fail('RC012_MTLS_PROBE_FILE_PERMISSION');
    certs[name]=fs.readFileSync(filename);
  }
  const clientCert=new X509Certificate(certs['client.crt']);
  const serverCert=new X509Certificate(certs['server.crt']);
  if(!serverCert.checkIP('127.0.0.1')
    ||clientCert.ca||serverCert.ca)
    fail('RC012_MTLS_PROBE_CERTIFICATE_SCOPE');
  const clientLeafSha256=createHash('sha256').update(clientCert.raw).digest('hex');
  const serverLeafSha256=createHash('sha256').update(serverCert.raw).digest('hex');
  const server=https.createServer({
    ca:certs['ca.crt'],key:certs['server.key'],cert:certs['server.crt'],
    minVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:true
  },(req,res)=>{
    if(req.url!=='/mcp'||req.socket.authorized!==true
      ||req.socket.getPeerCertificate()?.raw?.length<128){
      res.writeHead(403).end();return;
    }
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,transport:'owner-local-mtls'}));
  });
  server.on('tlsClientError',()=>{}); // No untrusted TLS payload or cert in logs.
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const port=server.address().port;
    function probe(authenticated){
      return new Promise(resolve=>{
        const req=https.request({
          host:'127.0.0.1',port,path:'/mcp',method:'GET',
          ca:certs['ca.crt'],minVersion:'TLSv1.3',
          ...(authenticated?{cert:certs['client.crt'],key:certs['client.key']}:{})
        },res=>{
          const chunks=[];
          // Node may clear IncomingMessage.socket before 'end'.
          const authorized=res.socket?.authorized===true;
          res.on('data',c=>chunks.push(c));
          res.on('end',()=>resolve({
            connected:true,status:res.statusCode,
            ok:Buffer.concat(chunks).toString().includes('"ok":true'),
            authorized
          }));
        });
        req.setTimeout(3000,()=>req.destroy());
        req.on('error',()=>resolve({connected:false}));
        req.end();
      });
    }
    const good=await probe(true),denied=await probe(false);
    if(good.status!==200||good.ok!==true||good.authorized!==true
      ||denied.status===200)
      fail('RC012_MTLS_PROBE_PAIR_AUTH_FAILED');
    // Optional: validate actual tunnel-client v0.0.15 can discover the same
    // ephemeral HTTPS/mTLS listener. A fake tunnel ID/API key intentionally
    // prevents any live account or tunnel mutation. Other Doctor checks
    // (OAuth metadata, health listener) need not pass for this transport smoke.
    let tunnelClientDoctor=null;
    if(args.length===2){
      const binary=fs.realpathSync.native(args[1]);
      const stat=fs.statSync(binary);
      if(!stat.isFile()||stat.size<10000)fail('RC012_MTLS_PROBE_TUNNEL_CLIENT_INVALID');
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'rc012-tunnel-client-doctor-'));
      try{
        const profile=path.join(tmp,'qa.yaml');
        fs.writeFileSync(profile,[
          'config_version: 1',
          'control_plane:',
          '  tunnel_id: '+('tunnel'+'_'+'0123456789abcdef'.repeat(2)),
          '  api_key: env:CONTROL_PLANE_API_KEY',
          'mcp:',
          '  server_urls:',
          '    - channel: main',
          '      url: https://127.0.0.1:'+port+'/mcp',
          '  client_cert: '+JSON.stringify(path.join(directory,'client.crt')),
          '  client_key: '+JSON.stringify(path.join(directory,'client.key'))
        ].join('\n'),{mode:0o600});
        const output=await new Promise((resolve,reject)=>{
          execFileCallback(binary,['doctor','--config',profile,
              '--ca-bundle',path.join(directory,'ca.crt'),'--json'],
            {windowsHide:true,timeout:7500,maxBuffer:1024*512,
              env:{...process.env,CONTROL_PLANE_API_KEY:'rc012-synthetic-no-real-api-key'}},
            (error,stdout)=>{
              if(error?.killed||error?.code==='ETIMEDOUT')return reject(error);
              resolve(String(stdout||''));
            });
        });
        let report;
        try{report=JSON.parse(output);}catch{fail('RC012_MTLS_PROBE_DOCTOR_JSON_INVALID');}
        const failed=report.failed_checks;
        if(!Array.isArray(failed)
          ||failed.includes('mcp_target')
          ||failed.includes('mcp_server_reachable')
          ||!Array.isArray(report.checks))
          fail('RC012_MTLS_PROBE_NATIVE_TUNNEL_DOCTOR_FAILED');
        tunnelClientDoctor='MCP_TLS_REACHABLE';
      }finally{fs.rmSync(tmp,{recursive:true,force:true});}
    }
    process.stdout.write(JSON.stringify({
      result:'RC012_OWNER_PAIR_MTLS_LOOPBACK_PASS',
      protocol:'TLSv1.3',authorizedPair:true,unauthenticatedDenied:true,
      expectedClientLeafDerSha256:clientLeafSha256,
      serverLeafDerSha256:serverLeafSha256,
      activeTunnelChanged:false,operationalOwnerGrantTested:false,
      tunnelClientDoctor
    })+'\n');
  }finally{
    await new Promise(resolve=>server.close(()=>resolve()));
  }
}
const entry=process.argv[1]&&path.resolve(process.argv[1]);
if(entry&&fileURLToPath(import.meta.url)===entry){
  main().catch(error=>{
    console.error(error?.code??'RC012_MTLS_PROBE_FAILED');
    process.exitCode=1;
  });
}
