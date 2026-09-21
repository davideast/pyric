import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createExecutionApp } from './execution-app.mjs';
import { createHostedApp } from './cloudrun-app.mjs';
import { instrumentStore } from '../adapters/store.mjs';
import provenance from '../deployment-provenance.json' with { type: 'json' };
import { mountObservabilityPreflight } from './observability-preflight.mjs';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const databaseId = process.env.ALLOWANCE_DATABASE;
const runId = process.env.ALLOWANCE_RUN_ID;
if (projectId !== 'digame-mas' || databaseId !== 'allowance-experiments' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId ?? '') || process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Explicit hosted experiment target required');
}
const instanceId = randomUUID();
const started = performance.now();
let sequence = 0;
const record = (kind, data = {}) => console.log(JSON.stringify({ caseId: 'cloudrun-combined-guard', ...data, kind, runId,
    role: 'server', instanceId, processId: process.pid, localSequence: sequence++, localElapsedMs: performance.now() - started,
    revision: process.env.K_REVISION ?? null, sourceHash: provenance.sourceHash }));
const firebase = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(firebase, databaseId);
const store = instrumentStore(db, `allowanceExperiments/${runId}/cases/cloudrun-combined-guard`, record);
const environment = { backend: 'firestore-admin', production: true, projectId, databaseId,
    nodeVersion: process.version, sdkVersion: createRequire(import.meta.url)('firebase-admin').SDK_VERSION,
    ...provenance, revision: process.env.K_REVISION ?? null };
let service;
if (process.env.ALLOWANCE_WORKLOAD === 'execution') {
    service = createExecutionApp({record,runId,instanceId,environment,
        createStore:async(caseId,trace)=>instrumentStore(db,`allowanceExperiments/${runId}/cases/${caseId}`,trace)});
} else {
    service = createHostedApp({ store, record, runId, instanceId, environment });
}
const { app, drain, stopAdmission } = service;
mountObservabilityPreflight(app, { db, project: projectId, database: databaseId, record });
const server = app.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', error => {
    if (error) throw error;
    record('server-ready', { environment });
});
let stopping = false;
process.on('SIGTERM', async () => {
    if (stopping) return;
    stopping = true;
    stopAdmission();
    const timeout = setTimeout(() => { record('shutdown-incomplete', { nativeCommitOutcome: 'unknown' }); process.exit(1); }, 8000);
    await new Promise(resolve => server.close(resolve));
    await drain();
    await deleteApp(firebase);
    clearTimeout(timeout);
    record('server-drained');
    process.exit(0);
});
