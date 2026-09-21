// Synthetic provider at the MessagePort boundary; exercises the real model transport.
import {configureDiagnostics} from '../remote-diagnostics';
import {generateWithModel} from '../generation-model';
import {modelOnPort} from '../generation-ai-transport';
self.addEventListener('connect',((event:MessageEvent)=>{
 const client=event.ports[0];
 client.onmessage=async event=>{
  configureDiagnostics(event.data);
  const channel=new MessageChannel();
  channel.port2.onmessage=({data:m})=>{
   if(m.method==='getRuntimeEpoch')channel.port2.postMessage({t:'res',id:m.id,ok:true,value:{version:'fixture'}});
   if(m.t==='sub'){
    channel.port2.postMessage({t:'snap',subId:m.subId,value:{chunk:{candidates:[{content:{role:'model',parts:[{text:'Synthetic response'}]},finishReason:'STOP'}]}}});
    channel.port2.postMessage({t:'snap',subId:m.subId,value:{done:true}});
   }
  };
  try {await generateWithModel(modelOnPort(channel.port1),'Synthetic request','{}',()=>{},new AbortController().signal);client.postMessage('complete');}
  catch {client.postMessage('failed');}
  finally {channel.port1.close();channel.port2.close();}
 };
 client.start();
})as EventListener);
