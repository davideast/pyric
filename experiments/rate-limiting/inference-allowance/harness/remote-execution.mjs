import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { httpScenarios } from '../scenarios/http-overload.mjs';

export async function runRemoteExecution({url,token=undefined,cases,record,onCase, nodeExecutable='node'}) {
    const headers={};
    if(token)headers.Authorization=`Bearer ${token}`;
    const control=async(path,method='GET')=>{
        const response=await fetch(url+path,{method,headers,redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error(`Control request ${path}: ${response.status}`);
        return response.json();
    };
    const health=await control('/health');
    if(health.inference!=='fake-lifecycle')throw new Error('Execution workload not deployed');
    const total=cases.reduce((sum,id)=>sum+httpScenarios[id].schedule.length,0);
    if(total>70||health.requestsObserved+total>health.requestCeilingPerInstance)throw new Error('Experiment request budget exceeded');
    for(const id of cases){
        await onCase(id,'running');
        const before=await control(`/cases/${id}/health`);
        record(id,'remote-case-ready',before);
        await new Promise((resolve,reject)=>{
            const child=fork(fileURLToPath(new URL('./http-load-generator.mjs',import.meta.url)),[],{execPath:nodeExecutable,silent:true});
            let stderr='';
            child.stdout.resume();child.stderr.on('data',data=>{stderr=(stderr+data).slice(-2000);});
            child.on('message',message=>{if(message.type==='event')record(id,message.kind,message.data);});
            child.on('error',reject);
            const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
            child.on('close',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(new Error(`Load generator failed (${code}): ${stderr}`));});
            child.send({schedule:httpScenarios[id].schedule,remote:{url,token,prefix:`/cases/${id}`}});
        });
        const after=await control(`/cases/${id}/drain`,'POST');
        record(id,'remote-case-drained',after);
        if(before.instanceId!==after.instanceId)throw new Error('Case changed instances');
        await onCase(id,'complete');
    }
    return {before:health,after:await control('/health')};
}
