import {openSync,closeSync,writeSync,fstatSync,ftruncateSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Plugin} from 'vite';
import {safeDiagnostic} from './diagnostic-schema';
export function diagnosticServer():Plugin {
 return {name:'kin-remote-diagnostics',apply:'serve',configureServer(server){
  let count=0,windowStart=Date.now();
  server.middlewares.use('/__kin/diagnostics',(req,res)=>{
   if(req.method!=='POST'){res.statusCode=405;res.end();return;}
   if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`){res.statusCode=403;res.end();return;}
   if(Date.now()-windowStart>60000){count=0;windowStart=Date.now();}
   if(++count>600){res.statusCode=429;res.end();return;}
   let body='',oversized=false;
   req.on('data',chunk=>{if(body.length+chunk.length>2048)oversized=true;else body+=chunk;});
   req.on('end',()=>{
    try {
     if(oversized)throw Error();
     const input=JSON.parse(body),safe=safeDiagnostic(input);
     if(!safe||Object.keys(input).some(k=>!Object.hasOwn(safe,k)))throw Error();
     const fd=openSync(join(tmpdir(),'kin-remote-diagnostics.jsonl'),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
     try {if(fstatSync(fd).size>1024*1024)ftruncateSync(fd,0);writeSync(fd,JSON.stringify({at:new Date().toISOString(),...safe})+'\n');}finally{closeSync(fd);}
     res.statusCode=204;
    }catch{res.statusCode=400;}
    res.end();
   });
  });
 }};
}
