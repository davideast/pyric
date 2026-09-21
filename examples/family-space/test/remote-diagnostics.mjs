import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
 const page = await browser.newPage();
 const sent=[];
 page.on('request',r=>{if(r.url().endsWith('/__kin/diagnostics'))sent.push(JSON.parse(r.postData()));});
 await page.goto(process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/');
 await page.evaluate(async()=>{const d=await import('/remote-diagnostics.ts');d.diagnostic('page-ready');});
 assert.equal(sent.length,0,'No telemetry without opt-in');
 await page.goto(new URL('?kinDiagnostics=1', process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/').href);
 const received=page.waitForResponse(r=>r.url().endsWith('/__kin/diagnostics') && r.status()===204);
 await page.evaluate(async()=>{const d=await import('/remote-diagnostics.ts');d.diagnostic('stage',{stage:'plan',prompt:'SECRET',error:'API_KEY'});});
 await received;
 assert(sent.some(e=>e.event==='stage'&&e.stage==='plan'));
 assert(!JSON.stringify(sent).includes('SECRET'));
 assert(!JSON.stringify(sent).includes('API_KEY'));
 const status=await page.evaluate(async()=> (await fetch('/__kin/diagnostics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:'stage',prompt:'SECRET'})})).status);
 assert.equal(status,400,'Server rejects payloads outside the fixed schema');
 const outcome=await page.evaluate(async()=>{
  const {diagnosticSettings}=await import('/remote-diagnostics.ts');
  const worker=new SharedWorker('/test/diagnostic-worker.ts',{type:'module',name:'diagnostic-test'});
  return await new Promise(resolve=>{worker.port.onmessage=e=>{worker.port.close();resolve(e.data);};worker.port.start();worker.port.postMessage(diagnosticSettings());});
 });
 assert.equal(outcome,'complete','Real worker/model transport completes with a synthetic provider');
 await page.goto(new URL('?kinDiagnostics=0', process.env.KIN_BASE_URL ?? 'http://127.0.0.1:5227/').href);
 const before=sent.length;
 await page.evaluate(async()=>{const d=await import('/remote-diagnostics.ts');d.diagnostic('page-ready');});
 assert.equal(sent.length,before,'Opt-out stops reporting');
 console.log('PASS opt-in, content exclusion, server validation, opt-out');
} finally {await browser.close();}
