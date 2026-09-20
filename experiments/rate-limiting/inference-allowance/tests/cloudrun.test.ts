import { expect, test } from 'bun:test';
import { createStore } from '../adapters/pyric-store.mjs';
import { createHostedApp } from '../services/cloudrun-app.mjs';

test('hosted experiment accepts only synthetic actors and keeps user admission slots after timeout', async () => {
    const events = [];
    const record = (kind, data) => events.push({kind, ...data});
    const store = await createStore({record, fault: async (boundary, meta) => {
        if (boundary === 'beforeRead' && meta.uid === 'alice') await new Promise(resolve => setTimeout(resolve, 150));
    }});
    const { app, drain } = createHostedApp({ store, record, runId: 'hosted-test', instanceId: 'test-instance', deadlineMs: 40, environment: { backend: 'pyric' } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const send = (uid, requestId, prompt = 'fixture') => fetch(`${url}/infer/chat`, {
        method:'POST', headers:{'Content-Type':'application/json', 'X-Experiment-User':uid},
        body: JSON.stringify({requestId, model:'test-model', prompt}),
    });
    try {
        expect((await send('attacker', 'invalid')).status).toBe(401);
        expect(events.filter(e => e.kind === 'transaction-attempt')).toHaveLength(0);
        const first = await send('alice', 'a');
        expect(first.status).toBe(504);
        const second = await send('alice', 'b');
        expect(second.status).toBe(504);
        expect((await send('alice', 'c')).status).toBe(503);
        expect((await send('bob', 'normal')).status).toBe(200);
        await drain();
        expect(events.some(e => e.kind === 'inference-dispatch' && e.uid === 'alice')).toBe(false);
        const healthResponse = await fetch(`${url}/health`);
        expect(healthResponse.status).toBe(200);
        const health = await healthResponse.json();
        expect(health).toMatchObject({backend:'pyric', inference:'fake', runId:'hosted-test'});
    } finally {
        await new Promise(resolve => server.close(resolve));
        await drain();
        await store.close();
    }
}, 10000);

test('Cloud Run source package contains only harness code and pinned dependencies', async () => {
    const { prepareCloudRun } = await import('../deployment/prepare-cloudrun.mjs');
    const { readFile, readdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const prepared = await prepareCloudRun();
    try {
        const files = await readdir(prepared.directory, { recursive: true });
        expect(files.some(path => /digame-mas|\.env|results|node_modules/.test(path))).toBe(false);
        const manifest = JSON.parse(await readFile(join(prepared.directory, 'package.json'), 'utf8'));
        expect(manifest.dependencies).toEqual({express:'5.2.1','firebase-admin':'13.10.0'});
        const lock = JSON.parse(await readFile(join(prepared.directory, 'package-lock.json'), 'utf8'));
        expect(lock.packages['node_modules/express'].version).toBe('5.2.1');
        expect(lock.packages['node_modules/firebase-admin'].version).toBe('13.10.0');
        expect(Object.keys(lock.packages).some(path => path.startsWith('..'))).toBe(false);
        const dockerfile = await readFile(join(prepared.directory, 'Dockerfile'), 'utf8');
        expect(dockerfile).toContain('npm ci');
        expect(dockerfile).toContain('USER node');
        expect(prepared.sourceHash).toHaveLength(64);
        const provenance = JSON.parse(await readFile(join(prepared.directory, 'deployment-provenance.json'), 'utf8'));
        expect(provenance.sourceHash).toBe(prepared.sourceHash);
        expect(provenance.files['services/cloudrun-entry.mjs']).toHaveLength(64);
    } finally { await rm(prepared.directory, { recursive: true, force: true }); }
});

test('hosted execution workload isolates cases, retains timed-out capacity, and rejects undefined workloads', async () => {
    const { createExecutionApp } = await import('../services/execution-app.mjs');
    const events = [], stores = [];
    const { app, drain } = createExecutionApp({ runId:'test-execution', instanceId:'local', environment:{backend:'pyric'},
        record:(kind,data)=>events.push({kind,...data}),
        createStore: async (_id,record) => { const store=await createStore({record});stores.push(store);return store; } });
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${server.address().port}`;
    const send=(caseId,requestId)=>fetch(`${url}/cases/${caseId}/infer/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Experiment-User':'alice'},body:JSON.stringify({requestId,model:'test-model',prompt:'fixture'})});
    try {
        expect((await fetch(url+'/cases/not-a-case/health')).status).toBe(404);
        expect((await fetch(url+'/health')).status).toBe(200);
        const first=await send('execution-timeout-ignored','held');
        expect(first.status).toBe(504);
        expect((await first.json()).status).toBe('inference_timeout');
        expect((await send('execution-timeout-ignored','retry')).status).toBe(503);
        expect((await send('execution-provider-error','independent')).status).toBe(200);
        await drain();
        expect((await send('execution-timeout-ignored','recovered')).status).toBe(200);
        expect(events.some(e=>e.caseId==='execution-timeout-ignored'&&e.kind==='provider-cancel-requested')).toBe(true);
    } finally {
        await new Promise(resolve=>server.close(resolve));await drain();
        await Promise.all(stores.map(s=>s.close()));
    }
},10000);

test('remote workload client and normalized assessment exercise the hosted router with Pyric', async () => {
    const { createExecutionApp } = await import('../services/execution-app.mjs');
    const { runRemoteExecution } = await import('../harness/remote-execution.mjs');
    const { assessHostedExecution } = await import('../analysis/hosted-execution.mjs');
    const { createRecorder } = await import('../harness/recorder.mjs');
    const { result,forCase }=createRecorder({backend:'pyric'});
    const cases=['execution-instance-guard','execution-stream','execution-timeout-ignored'];
    result.run.selectedCases=cases;
    let sequence=0;
    const started=performance.now();
    const service=createExecutionApp({runId:result.run.id,instanceId:'local',environment:{backend:'pyric'},
        record:(kind,data)=>forCase(data.caseId).record(kind,{...data,role:'server',instanceId:'local',localSequence:sequence++,localElapsedMs:performance.now()-started}),
        createStore:async(_id,record)=>createStore({record})});
    const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    try {
        await runRemoteExecution({url:`http://127.0.0.1:${server.address().port}`,cases,
            record:(id,kind,data)=>forCase(id).record(kind,data),onCase:async(id,status)=>{
                let row=result.cases.find(c=>c.id===id);if(!row){row={id,status};result.cases.push(row);}row.status=status;
            }});
        const assessment=assessHostedExecution(result);
        expect(assessment.issues).toEqual([]);
        expect(assessment.evidenceComplete).toBe(true);
        const incomplete=structuredClone(result);
        incomplete.events=incomplete.events.filter(e=>e.kind!=='transaction-attempt'&&e.kind!=='provider-active');
        expect(assessHostedExecution(incomplete).evidenceComplete).toBe(false);
        const changedInstance=structuredClone(result);
        for(const event of changedInstance.events) if(event.caseId==='execution-stream'&&event.instanceId)event.instanceId='another';
        expect(assessHostedExecution(changedInstance).evidenceComplete).toBe(false);
        expect(assessment.http['execution-instance-guard'].execution.peakActiveProviderCalls).toBe(2);
        expect(assessment.http['execution-stream'].execution.chunksReceived).toBe(3);
        expect(assessment.http['execution-timeout-ignored'].execution.inferenceTimeouts).toBe(1);
    } finally {await service.drain();await new Promise(resolve=>server.close(resolve));}
},15000);
