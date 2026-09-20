import {appendFileSync} from 'node:fs';
import {readFile,writeFile,mkdir,cp,symlink,unlink,readdir} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {receiptPath,quotaPath} from '../architecture/admission.mjs';
import {captureDefinition} from '../capture-definition.mjs';
import {runRemoteExecution} from '../harness/remote-execution.mjs';
import {createRecorder} from '../harness/recorder.mjs';
import {assessHostedExecution} from '../analysis/hosted-execution.mjs';
import {httpScenarios,httpWorkload} from '../scenarios/http-overload.mjs';
import config from '../config/inference-concurrency.json' with {type:'json'};
import { recordRunObservability } from '../../../shared/observability/run-report.mjs';
import observabilityManifest from '../observability.json' with { type: 'json' };
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../../..');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function seal(out,status){
    const files=[];
    async function visit(path,prefix=''){
        for(const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
            const name=prefix+entry.name;
            if(entry.isDirectory())await visit(join(path,entry.name),name+'/');
            else if(name!=='manifest.json'){
                const bytes=await readFile(join(path,entry.name));files.push({path:name,sha256:sha(bytes),bytes:bytes.length});
            }
        }
    }
    await visit(out);await save(join(out,'manifest.json'),{formatVersion:1,captureKind:'inference-execution-measurement',status,files,credentialsBundled:false});
}
const [mode,...args]=process.argv.slice(2);
if(mode!=='--captured'){
    if(!['local','run'].includes(mode)|| (mode==='run'&&args.length!==3))throw new Error('Usage: node deployment/run-execution.mjs local | run DEPLOYMENT_RECORD DEPLOYER_KEY RUNTIME_KEY');
    const out=join(here,'measurements',randomUUID());
    const source=join(out,'source');await mkdir(source,{recursive:true});
    await recordRunObservability(out, { backend: mode === 'local' ? 'local' : 'cloud-run',
        project: 'digame-mas', database: 'allowance-experiments', service: 'allowance-overload', region: 'us-east4',
        reportFile: process.env.PYRIC_OBSERVABILITY_REPORT,
        requirePreflight: process.env.PYRIC_REQUIRE_OBSERVABILITY_PREFLIGHT === '1', manifest: observabilityManifest });
    for(const path of captureDefinition().sourcePaths){await mkdir(dirname(join(source,path)),{recursive:true});await cp(join(root,path),join(source,path));}
    if(mode==='run'){
        await cp(join(resolve(args[0]),'source'),join(out,'server-source'),{recursive:true});
        await cp(join(resolve(args[0]),'deployment-report.json'),join(out,'deployment-report.json'));
    }
    console.log(JSON.stringify({stage:'starting',mode,directory:out}));
    const modules=join(source,'node_modules');await symlink(join(root,'node_modules'),modules,'dir');
    let status='incomplete';
    const logWindow={startedAt:new Date().toISOString()};
    try {
        const executable=join(source,'experiments/rate-limiting/inference-allowance/deployment/run-execution.mjs');
        const child=spawnSync(process.execPath,[executable,'--captured',mode,out,...args.slice(1).map(p=>resolve(p))],{stdio:'inherit',timeout:240000});
        if(child.error||child.status!==0)process.exitCode=1;else status='complete';
    }finally{
        await unlink(modules);
        if(mode==='run'){
            await save(join(out,'log-window.json'),{...logWindow,endedAt:new Date().toISOString()});
            const {captureMeasurementLogs}=await import('./capture-logs.mjs');
            const capture=await captureMeasurementLogs(out,resolve(args[1]));
            console.log(JSON.stringify({stage:'log-capture',collectionStatus:capture.collectionStatus,coverage:capture.coverage.status}));
        }
        await seal(out,status);
    }
    console.log(JSON.stringify({directory:out,status}));
}else{
    const [backend,out,deployerKey,runtimeKey]=args;
    const {result,forCase}=createRecorder({backend},undefined,event=>appendFileSync(join(out,'observations.partial.ndjson'),JSON.stringify(event)+'\n'));
    result.run.selectedCases=config.cases;
    result.run.suite='inference-execution-hosted-comparison';
    result.run.workload={...httpWorkload,inference:'scenario-configured observable fake provider; no real inference',
        scenarios:Object.fromEntries(config.cases.map(id=>[id,httpScenarios[id]]))};
    result.run.workloadHash=sha(JSON.stringify(result.run.workload));
    const portable=['architecture/gateway.mjs','architecture/admission.mjs','architecture/bucket.mjs','adapters/store.mjs',
        'services/lifecycle-inference.mjs','services/inference-http.mjs','services/execution-app.mjs','scenarios/http-overload.mjs','fixtures/policies.json'];
    result.run.architectureFiles={};
    for(const path of portable)result.run.architectureFiles[path]=sha(await readFile(new URL('../'+path,import.meta.url)));
    result.run.architectureHash=sha(JSON.stringify(result.run.architectureFiles));
    const persist=async()=>{await save(join(out,'result.json'),result);await writeFile(join(out,'events.ndjson'),result.events.map(e=>JSON.stringify(e)).join('\n')+'\n');};
    let logsCollected=false;
    let url,token,cleanup=async()=>{},snapshot=async()=>({available:false,reason:'Local HTTP adapter does not export snapshots'}),readLogs;
    try{
        if(backend==='local'){
            const {createExecutionApp}=await import('../services/execution-app.mjs');
            const {createStore,environment}=await import('../adapters/pyric-store.mjs');
            let sequence=0;const start=performance.now();
            const service=createExecutionApp({runId:result.run.id,instanceId:'local',environment,
                record:(kind,data)=>forCase(data.caseId).record(kind,{...data,role:'server',instanceId:'local',localSequence:sequence++,localElapsedMs:performance.now()-start}),
                createStore:async(_id,record)=>createStore({record})});
            const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
            url=`http://127.0.0.1:${server.address().port}`;
            cleanup=async()=>{await service.drain();await new Promise(resolve=>server.close(resolve));};
            result.run.environment={...environment,transport:'loopback HTTP; same hosted router',clientNodeVersion:process.version};
        }else{
            const {initializeApp,cert,deleteApp}=await import('firebase-admin/app');
            const {getFirestore}=await import('firebase-admin/firestore');
            const deployer=await json(deployerKey),runtime=await json(runtimeKey);
            if([deployer,runtime].some(k=>k.project_id!=='digame-mas'||k.type!=='service_account'))throw new Error('Expected digame-mas identities');
            const deployment=await json(join(out,'deployment-report.json'));
            url=deployment.url;
            if(url!=='https://allowance-overload-77eiz5rbyq-uk.a.run.app'||deployment.database.name!=='projects/digame-mas/databases/allowance-experiments'||deployment.workload!=='execution')throw new Error('Unexpected execution target');
            const provenance=await json(join(out,'server-source/deployment-provenance.json'));
            for(const [name,digest]of Object.entries(provenance.files))if(sha(await readFile(join(out,'server-source',name)))!==digest)throw new Error('Server source mismatch');
            if(sha(JSON.stringify(provenance.files))!==deployment.sourceHash)throw new Error('Deployment digest mismatch');
            for(const path of portable)if(result.run.architectureFiles[path]!==provenance.files[path])throw new Error('Client and server architecture differ: '+path);
            const env={...process.env,CLOUDSDK_CONFIG:join(tmpdir(),'allowance-cloudrun-gcloud'),CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:deployerKey};
            token=execFileSync('gcloud',['auth','print-identity-token',`--audiences=${url}`,'--project=digame-mas'],{env,encoding:'utf8'}).trim();
            const health=await fetch(url+'/health',{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(20000)});
            if(!health.ok)throw new Error('Private health failed: '+health.status);
            const metadata=await health.json();
            if(metadata.runId!==deployment.runId||metadata.sourceHash!==deployment.sourceHash||metadata.revision!==deployment.revision)throw new Error('Service provenance changed');
            result.run.environment={...metadata,transport:'remote HTTPS to Cloud Run HTTP/1.1 container',clientNodeVersion:process.version,
                limitations:['Client disconnect may not propagate through Cloud Run proxy','Synthetic operator-selected identity, not Firebase end-user auth','Per-process guard; not a global semaphore','Fake provider cancellation, not AI Logic']};
            const firebase=initializeApp({projectId:'digame-mas',credential:cert(runtime)});
            cleanup=()=>deleteApp(firebase);
            const db=getFirestore(firebase,'allowance-experiments');
            snapshot=async()=>Object.fromEntries(await Promise.all(config.cases.map(async id=>[id,Object.fromEntries(await Promise.all(['quotas','admissions'].map(async collection=>[collection,
                (await db.collection(`allowanceExperiments/${deployment.runId}/cases/${id}/${collection}`).get()).docs.map(d=>({path:d.ref.path,data:d.data()}))])))])));
            const initial=await snapshot();await save(join(out,'initial-state.json'),initial);
            // Only the deployment smoke actor is permitted before measuring; never reset state to get a pass.
            const used=Object.entries(initial).flatMap(([id,state])=>[...state.admissions,...state.quotas].filter(row=>{
                const smokePaths=[receiptPath('dave','deployment-smoke'),quotaPath('dave')];
                return id!=='execution-user-guard'||!smokePaths.some(path=>row.path.endsWith('/'+path));
            }));
            if(used.length)throw new Error('Workload namespace already used; deploy a fresh isolated run');
            const credential=cert(deployer);
            readLogs=async()=>{
                const {access_token:accessToken}=await credential.getAccessToken();
                let entries=[];
                for(let round=0;round<12;round++){
                    entries=[];let pageToken;
                    do{
                        const body={resourceNames:['projects/digame-mas'],filter:`resource.type="cloud_run_revision" AND resource.labels.service_name="allowance-overload" AND jsonPayload.runId="${deployment.runId}" AND timestamp>="${result.run.workloadStartedAt}"`,pageSize:1000,orderBy:'timestamp asc'};
                        if(pageToken)body.pageToken=pageToken;
                        const response=await fetch('https://logging.googleapis.com/v2/entries:list',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
                        if(!response.ok)throw new Error('Log collection failed: '+response.status);
                        const page=await response.json();entries.push(...(page.entries??[]));pageToken=page.nextPageToken;
                    }while(pageToken);
                    await save(join(out,'cloud-logging.json'),entries);
                    const settled=new Set(entries.filter(e=>e.jsonPayload?.kind==='request-work-settled').map(e=>e.jsonPayload.attemptId));
                    const observed=entries.map(e=>e.jsonPayload).filter(e=>config.cases.includes(e?.caseId));
                    const byInstance=new Map();
                    for(const event of observed){if(!byInstance.has(event.instanceId))byInstance.set(event.instanceId,new Set());byInstance.get(event.instanceId).add(event.localSequence);}
                    const contiguous=[...byInstance.values()].every(values=>values.size===Math.max(...values)-Math.min(...values)+1);
                    const drains=new Set(observed.filter(e=>e.kind==='case-drained').map(e=>e.caseId));
                    const offered=result.events.filter(e=>e.kind==='client-dispatch').length;
                    if(settled.size>=offered&&contiguous&&drains.size>=result.cases.filter(c=>c.status==='complete').length)break;
                    await new Promise(resolve=>setTimeout(resolve,5000));
                }
                const unique=new Map(entries.map(e=>[`${e.logName}/${e.insertId}`,e]));
                const events=[...unique.values()].map(e=>({...e.jsonPayload,cloudTimestamp:e.timestamp})).filter(e=>config.cases.includes(e.caseId));
                events.sort((a,b)=>a.instanceId.localeCompare(b.instanceId)||a.localSequence-b.localSequence);
                for(const event of events)forCase(event.caseId).record(event.kind,{...event,backendRunId:event.runId});
                logsCollected=true;
            };
        }
        await save(join(out,'environment.json'),result.run.environment);
        await save(join(out,'workload.json'),result.run.workload);
        result.run.workloadStartedAt=new Date().toISOString();await persist();
        const health=await runRemoteExecution({url,token,cases:config.cases,
            record:(id,kind,data)=>forCase(id).record(kind,data),onCase:async(id,status)=>{
                let row=result.cases.find(c=>c.id===id);if(!row){row={id,status};result.cases.push(row);}row.status=status;await persist();
                console.log(JSON.stringify({case:id,status}));
            }});
        await save(join(out,'health.json'),health);
        if(health.before.sourceHash!==health.after.sourceHash||health.before.instanceId!==health.after.instanceId)throw new Error('Service changed during workload');
        if(readLogs)await readLogs();
        await save(join(out,'final-state.json'),await snapshot());
        const assessment=assessHostedExecution(result);
        result.run.finishedAt=new Date().toISOString();await persist();
        await save(join(out,'assessment.json'),assessment);
        console.log(JSON.stringify({successfulExperiment:assessment.successfulExperiment,issues:assessment.issues,assertions:result.assertions.length}));
        if(!assessment.evidenceComplete)process.exitCode=1;
        // Complete behavioral divergences are retained; missing evidence fails execution.
    }catch(error){
        result.run.error=error.message;
        result.run.collectionErrors=[];
        if(readLogs&&!logsCollected){try{await readLogs();}catch(collectionError){result.run.collectionErrors.push(collectionError.message);}}
        try{await save(join(out,'final-state.json'),await snapshot());}catch(collectionError){result.run.collectionErrors.push(collectionError.message);}
        await persist();throw error;
    }
    finally{await cleanup();}
}
