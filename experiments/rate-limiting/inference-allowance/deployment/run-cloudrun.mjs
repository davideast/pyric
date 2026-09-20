// Bounded measurement of the existing private combined-guard service. No deployment or IAM changes.
import { readFile, writeFile, mkdir, cp, symlink, unlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, value) => writeFile(p, JSON.stringify(value, null, 2) + '\n');
const sha = data => createHash('sha256').update(data).digest('hex');
const [mode, ...args] = process.argv.slice(2);
if (mode !== '--captured') {
    if (args.length !== 3 || mode !== 'run') throw new Error('Usage: node deployment/run-cloudrun.mjs run DEPLOYMENT_RECORD DEPLOYER_KEY RUNTIME_KEY');
    const [deploymentPath, deployerKey, runtimeKey] = args.map(p => resolve(p));
    const report = await json(join(deploymentPath, 'deployment-report.json'));
    const id = randomUUID();
    const out = join(here, 'measurements', id);
    await mkdir(join(out, 'source'), { recursive: true });
    const { recordRunObservability } = await import('../../../shared/observability/run-report.mjs');
    const observabilityManifest = await json(new URL('../observability.json', import.meta.url));
    await recordRunObservability(out, { backend: 'cloud-run', project: 'digame-mas', database: 'allowance-experiments', service: 'allowance-overload', region: 'us-east4',
        reportFile: process.env.PYRIC_OBSERVABILITY_REPORT,
        requirePreflight: process.env.PYRIC_REQUIRE_OBSERVABILITY_PREFLIGHT === '1', manifest: observabilityManifest });
    await cp(new URL('../../../shared/observability/', import.meta.url), join(out, 'source/observability'), { recursive: true });
    await save(join(out, 'source/observability.json'), observabilityManifest);
    await cp(join(deploymentPath, 'source'), join(out, 'server-source'), { recursive: true });
    await save(join(out, 'deployment-report.json'), report);
    await cp(fileURLToPath(import.meta.url), join(out, 'source/run-cloudrun.mjs'));
    const modules = join(out, 'source/node_modules');
    await symlink(resolve(here, '../../../../node_modules'), modules, 'dir');
    console.log(JSON.stringify({ stage: 'starting', directory: out, deploymentRunId: report.runId }));
    const logWindow={startedAt:new Date().toISOString()};
    try {
        const child = spawnSync(process.execPath, [join(out, 'source/run-cloudrun.mjs'), '--captured', out, deployerKey, runtimeKey],
            { stdio: 'inherit', timeout: 180000 });
        if (child.error || child.status !== 0) process.exitCode = 1;
    } finally {
        await unlink(modules);
        await save(join(out,'log-window.json'),{...logWindow,endedAt:new Date().toISOString()});
        const {captureMeasurementLogs}=await import('./capture-logs.mjs');
        const capture=await captureMeasurementLogs(out,deployerKey);
        console.log(JSON.stringify({stage:'log-capture',collectionStatus:capture.collectionStatus,coverage:capture.coverage.status}));
    }
    const files = [];
    async function walk(dir, prefix = '') {
        const { readdir } = await import('node:fs/promises');
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
            const path = prefix + entry.name;
            if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/');
            else if (path !== 'manifest.json') { const bytes = await readFile(join(dir, entry.name)); files.push({ path, sha256: sha(bytes), bytes: bytes.length }); }
        }
    }
    await walk(out);
    await save(join(out, 'manifest.json'), { formatVersion: 1, captureKind: 'cloudrun-http-measurement', execution: 'copied-client-source-and-verified-deployed-source', id,
        files, status: process.exitCode ? 'incomplete-or-failed' : 'complete', credentialsBundled: false });
    console.log(JSON.stringify({ directory: out, exitCode: process.exitCode ?? 0 }));
} else {
    const [out, deployerKey, runtimeKey] = args;
    const deployment = await json(join(out, 'deployment-report.json'));
    const deployer = await json(deployerKey), runtime = await json(runtimeKey);
    if ([deployer, runtime].some(k => k.project_id !== 'digame-mas' || k.type !== 'service_account')) throw new Error('Expected digame-mas service accounts');
    const url = deployment.url;
    if (url !== 'https://allowance-overload-77eiz5rbyq-uk.a.run.app' || deployment.database.name !== 'projects/digame-mas/databases/allowance-experiments') throw new Error('Unexpected experiment target');
    const credential = cert(deployer);
    const runtimeApp = initializeApp({ projectId: 'digame-mas', credential: cert(runtime) });
    const db = getFirestore(runtimeApp, 'allowance-experiments');
    const env = { ...process.env, CLOUDSDK_CONFIG: join(tmpdir(), 'allowance-cloudrun-gcloud'), CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: deployerKey };
    const token = execFileSync('gcloud', ['auth','print-identity-token',`--audiences=${url}`,'--project=digame-mas'], { env, encoding: 'utf8' }).trim();
    const health = async () => {
        const response = await fetch(url + '/health', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Health status ${response.status}`);
        const data = await response.json();
        if (data.sourceHash !== deployment.sourceHash || data.runId !== deployment.runId || data.revision !== deployment.revision || data.inference !== 'fake') throw new Error('Deployment provenance changed');
        return data;
    };
    const before = await health();
    const root = db.doc(`allowanceExperiments/${deployment.runId}/cases/cloudrun-combined-guard`);
    const snapshot = async () => Object.fromEntries(await Promise.all(['quotas','admissions'].map(async name => [name,
        (await root.collection(name).get()).docs.map(d => ({ path: d.ref.path, data: d.data() }))])));
    const initialState = await snapshot();
    const provenance = await json(join(out, 'server-source/deployment-provenance.json'));
    for (const [name, digest] of Object.entries(provenance.files)) if (sha(await readFile(join(out,'server-source',name))) !== digest) throw new Error('Server snapshot hash mismatch');
    if (sha(JSON.stringify(provenance.files)) !== before.sourceHash) throw new Error('Server snapshot does not match live service');
    const id = out.split('/').at(-1), prefix = id.slice(0,8);
    const startTime = new Date().toISOString(), started = performance.now();
    const result = { schemaVersion: 2, run: { id, suite: 'cloudrun-combined-guard-observation', startedAt: startTime, deploymentRunId: deployment.runId,
        environment: { ...before, clientNodeVersion: process.version, transport: 'remote HTTPS to Cloud Run; IAM operator authentication', faultInjection: 'none', controlledClock: false },
        comparison: { equivalentToLocalHttpSuite: false, reasons: ['No injected 600ms Firestore delay', 'Server wall clock and lazy refill', 'Real IAM/TLS/network and Firestore', 'Only combined-guard variant; no unguarded control', 'Existing backend run with initial-state snapshot'] } },
        cases: [], events: [], assertions: [], inferences: [] };
    const record = (caseId, kind, data = {}) => {
        const event = { ...data, id: randomUUID(), runId:id, caseId, sequence:result.events.length, elapsedMs:performance.now()-started, kind };
        result.events.push(event); return event;
    };
    const check = (name, actual, expected) => result.assertions.push({ runId:id, caseId:'cloudrun-combined-guard', name, actual, expected, passed:JSON.stringify(actual)===JSON.stringify(expected), expectedPass:true });
    const schedule = [], requests = new Map();
    const persist = async () => { await save(join(out,'result.json'),result); await writeFile(join(out,'events.ndjson'),result.events.map(e=>JSON.stringify(e)).join('\n')+'\n'); };
    const send = async (phase, uid, label, route = 'chat', atMs = 0, phaseStart = performance.now()) => {
        const requestId = `${prefix}-${label}`;
        const traceId=randomUUID().replaceAll('-','');
        const item = { phase, uid, requestId, route, traceId, requestPath:'/infer/'+route, scheduledMs:atMs };
        schedule.push(item); requests.set(requestId,item);
        const actual = performance.now()-phaseStart;
        record(phase,'client-dispatch',{...item,role:'client',actualMs:actual,schedulerLagMs:actual-atMs});
        const dispatched = performance.now();
        try {
            const response = await fetch(url + '/infer/' + route, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Experiment-User':uid,'X-Cloud-Trace-Context':traceId+'/1;o=1'},
                body:JSON.stringify({requestId,model:'test-model',prompt:'synthetic hosted overload experiment'}),signal:AbortSignal.timeout(15000) });
            const text = await response.text(); let body;
            try { body=JSON.parse(text); } catch { body={status:'non_json_response'}; }
            return record(phase,'client-response',{...item,...body,role:'client',httpStatus:response.status,durationMs:performance.now()-dispatched});
        } catch(error) { return record(phase,'client-error',{...item,role:'client',error:error.name,durationMs:performance.now()-dispatched}); }
    };
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const runPhase = async (phase, items) => {
        const row={id:phase,status:'running'};result.cases.push(row);await persist();
        const at=performance.now();
        await Promise.all(items.map(item=>new Promise(resolve=>setTimeout(()=>send(phase,item.uid,item.label,item.route??'chat',item.atMs??0,at).then(resolve),item.atMs??0))));
        row.status='complete';await persist();
        console.log(JSON.stringify({phase,outcomes:result.events.filter(e=>e.caseId===phase&&e.kind==='client-response').reduce((m,e)=>(m[e.status]=(m[e.status]??0)+1,m),{})}));
    };
    // Bounded schedule: 88 requests, never more than 56 launched in one phase.
    if (before.requestsObserved + 88 > before.requestCeilingPerInstance) throw new Error('Insufficient process request budget; redeploy an isolated run before measuring');
    await save(join(out,'environment.json'),result.run.environment);
    await save(join(out,'initial-state.json'),initialState);
    try {
        await runPhase('normal-baseline',Array.from({length:6},(_,i)=>({uid:i%2?'eve':'dave',label:`baseline-${i}`,atMs:i*100})));
        await runPhase('single-user-burst',[
            ...Array.from({length:50},(_,i)=>({uid:'alice',label:`burst-${i}`})),
            ...Array.from({length:6},(_,i)=>({uid:i%2?'carol':'bob',label:`normal-${i}`,atMs:100+i*100}))]);
        await runPhase('many-user-burst',Array.from({length:20},(_,i)=>({uid:`user${i}`,label:`many-${i}`})));
        await sleep(7000); // One chat credit refills every six seconds.
        await runPhase('recovery',[{uid:'alice',label:'recovery'}]);
        const row={id:'agent-allowance',status:'running'};result.cases.push(row);
        for(let i=0;i<3;i++) await send('agent-allowance','eve',`agent-${i}`,'agent');
        row.status='complete';await persist();
        await runPhase('duplicate-retry',[{uid:'alice',label:'recovery'}]);
        await runPhase('invalid-actor',[{uid:'outsider',label:'invalid'}]);
        result.run.finishedRequestsAt=new Date().toISOString();
        await save(join(out,'workload.json'),{revision:1,maxRequests:88,inference:'fake-immediate',faultInjection:'none',schedule});
        const after=await health();await save(join(out,'health-after.json'),after);
        const {access_token:accessToken}=await credential.getAccessToken();
        // Logs arrive asynchronously. Require all distinct server requests to settle; preserve partial capture on timeout.
        let entries=[];
        for(let round=0;round<12;round++) {
            entries=[];let pageToken;
            do {
                const response=await fetch('https://logging.googleapis.com/v2/entries:list',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),
                    body:JSON.stringify({resourceNames:['projects/digame-mas'],filter:`resource.type="cloud_run_revision" AND resource.labels.service_name="allowance-overload" AND jsonPayload.runId="${deployment.runId}" AND timestamp>="${startTime}"`,pageSize:1000,orderBy:'timestamp asc',...(pageToken?{pageToken}:{})})});
                if(!response.ok) throw new Error(`Log collection failed: ${response.status}`);
                const page=await response.json();entries.push(...(page.entries??[]));pageToken=page.nextPageToken;
            }while(pageToken);
            const starts=entries.filter(e=>e.jsonPayload?.kind==='request-start'&&requests.has(e.jsonPayload.requestId));
            const ids=new Set(starts.map(e=>e.jsonPayload.attemptId));
            const settled=new Set(entries.filter(e=>e.jsonPayload?.kind==='request-work-settled'&&ids.has(e.jsonPayload.attemptId)).map(e=>e.jsonPayload.attemptId));
            if(starts.length===88&&settled.size===88)break;
            await sleep(5000);
        }
        await save(join(out,'cloud-logging.json'),entries);
        const unique=new Map(entries.map(e=>[`${e.logName}/${e.insertId}`,e]));
        const logs=[...unique.values()].map(e=>({...e.jsonPayload,cloudTimestamp:e.timestamp,cloudInsertId:e.insertId}));
        const starts=logs.filter(e=>e.kind==='request-start'&&requests.has(e.requestId));
        const attemptIds=new Set(starts.map(e=>e.attemptId));
        const selected=logs.filter(e=>requests.has(e.requestId)||attemptIds.has(e.attemptId)||e.kind==='outstanding');
        for(const event of selected) record('cloudrun-combined-guard',event.kind,{...event,backendRunId:event.runId,backendCaseId:event.caseId});
        result.inferences=result.events.filter(e=>e.kind==='inference-dispatch');
        const finalState=await snapshot();await save(join(out,'final-state.json'),finalState);
        const client=result.events.filter(e=>e.kind==='client-response');
        const serverResponses=selected.filter(e=>e.kind==='request-response');
        const settled=selected.filter(e=>e.kind==='request-work-settled');
        const busyIds=new Set(serverResponses.filter(e=>e.status==='admission_busy').map(e=>e.attemptId));
        const tx=selected.filter(e=>e.kind==='transaction-attempt');
        check('all client responses observed',client.length,88);
        check('no client transport errors',result.events.filter(e=>e.kind==='client-error').length,0);
        check('all server requests captured',starts.length,88);
        check('all server responses captured',serverResponses.length,88);
        check('all work settled',new Set(settled.map(e=>e.attemptId)).size,88);
        check('server revision stable',after.revision,before.revision);
        check('user admission never exceeds two',selected.filter(e=>e.kind==='outstanding'&&e.value>2).length,0);
        check('instance admission never exceeds sixteen',selected.filter(e=>e.kind==='outstanding'&&e.instanceValue>16).length,0);
        check('busy requests avoid Firestore',tx.filter(e=>busyIds.has(e.attemptId)).length,0);
        check('baseline normal users complete',client.filter(e=>e.caseId==='normal-baseline'&&e.status==='completed').length,6);
        check('other users complete during Alice burst',client.filter(e=>e.caseId==='single-user-burst'&&e.uid!=='alice'&&e.status==='completed').length,6);
        check('recovery completes',client.find(e=>e.caseId==='recovery')?.status,'completed');
        check('duplicate does not dispatch twice',selected.filter(e=>e.kind==='inference-dispatch'&&e.requestId===`${prefix}-recovery`).length,1);
        check('invalid actor rejected',client.find(e=>e.caseId==='invalid-actor')?.status,'unauthenticated');
        check('agent allowance outcomes',client.filter(e=>e.caseId==='agent-allowance').map(e=>e.status),['completed','completed','quota_exhausted']);
        check('every completed request has a fake inference dispatch',selected.filter(e=>e.kind==='inference-dispatch').length,client.filter(e=>e.status==='completed').length);
        const initialReceiptIds=new Set(initialState.admissions.map(e=>e.path));
        const newReceipts=finalState.admissions.filter(e=>!initialReceiptIds.has(e.path));
        check('receipt count matches admitted decisions',newReceipts.length,selected.filter(e=>e.kind==='admission-decision'&&e.status==='admitted').length);
        check('saved quota balances remain in range',finalState.quotas.flatMap(e=>Object.entries(e.data.buckets)).filter(([category,b])=>b.remaining<0||b.remaining>({chat:5,agent:2}[category]*60000)).length,0);
        function distribution(values) {const a=values.toSorted((a,b)=>a-b);return {samples:a.length,p50Ms:a[Math.ceil(a.length*.5)-1]??null,p95Ms:a[Math.ceil(a.length*.95)-1]??null,maxMs:a.at(-1)??null};}
        const summary={phases:Object.fromEntries(result.cases.map(c=>{const events=client.filter(e=>e.caseId===c.id);return [c.id,{requests:events.length,outcomes:events.reduce((m,e)=>(m[e.status]=(m[e.status]??0)+1,m),{}),latency:distribution(events.map(e=>e.durationMs)),latencyByOutcome:Object.fromEntries([...new Set(events.map(e=>e.status))].map(status=>[status,distribution(events.filter(e=>e.status===status).map(e=>e.durationMs))]))}];})),
            normalDuringBurst:distribution(client.filter(e=>e.caseId==='single-user-burst'&&e.uid!=='alice').map(e=>e.durationMs)),
            server:{instances:[...new Set(starts.map(e=>e.instanceId))],peakUserAdmission:Math.max(0,...selected.filter(e=>e.kind==='outstanding').map(e=>e.value)),peakInstanceAdmission:Math.max(0,...selected.filter(e=>e.kind==='outstanding').map(e=>e.instanceValue)),transactionAttempts:tx.length,transactionInvocations:new Set(tx.map(e=>e.invocationId)).size,transactionErrors:selected.filter(e=>e.kind==='transaction-error'),inferenceDispatches:result.inferences.length},
            assertions:{passed:result.assertions.filter(a=>a.passed).length,total:result.assertions.length,failures:result.assertions.filter(a=>!a.passed)},
            limitations:result.run.comparison.reasons.concat(['Small bounded warm-service observation; no sustained saturation, autoscaling, process RSS/event-loop metrics, or Firebase user-token verification','Admission guard releases before inference; fake inference is immediate','Cloud Logging ingestion is asynchronous; coverage checks determine completeness'])};
        await save(join(out,'summary.json'),summary);
        result.run.finishedAt=new Date().toISOString();await persist();
        console.log(JSON.stringify(summary,null,2));
        if(result.assertions.some(a=>!a.passed))process.exitCode=1;
    } catch(error) {result.run.error=error.message;await persist();throw error;}
    finally {await deleteApp(runtimeApp);}
}
