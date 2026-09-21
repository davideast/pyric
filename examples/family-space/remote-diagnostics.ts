import {safeDiagnostic,type DiagnosticEvent} from './diagnostic-schema';
let settings: {trace:string;expires:number}|undefined;
export function configureDiagnostics(value: unknown) {
 if(!import.meta.env.DEV)return;
 const v=value as typeof settings;
 settings=v && typeof v.expires==='number' && v.expires>Date.now() && v.expires<=Date.now()+16*60000 && safeDiagnostic({event:'page-ready',trace:v.trace}) ? v : undefined;
}
if(import.meta.env.DEV && typeof window!=='undefined') {
 try {
  const query=new URLSearchParams(location.search).get('kinDiagnostics');
  if(query==='0')sessionStorage.removeItem('kin-diagnostics');
  if(query==='1')sessionStorage.setItem('kin-diagnostics',JSON.stringify({trace:crypto.randomUUID(),expires:Date.now()+15*60000}));
  configureDiagnostics(JSON.parse(sessionStorage.getItem('kin-diagnostics')??'null'));
 }catch{}
}
export function diagnosticSettings(){return settings&&settings.expires>Date.now()?settings:undefined;}
export function diagnostic(event: DiagnosticEvent, fields: {stage?:string;elapsedMs?:number;code?:string}={}) {
 if(!import.meta.env.DEV||!diagnosticSettings())return;
 const payload=safeDiagnostic({...fields,event,trace:settings!.trace});
 if(!payload)return;
 try {void fetch(new URL('/__kin/diagnostics',location.origin),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true}).catch(()=>{});}catch{}
}
export function diagnosticCode(error:unknown) {
 return error instanceof Error && /90 seconds|handshake|timed out/i.test(error.message)?'timeout':error instanceof Error&&error.name==='AbortError'?'aborted':'error';
}
diagnostic('page-ready');
