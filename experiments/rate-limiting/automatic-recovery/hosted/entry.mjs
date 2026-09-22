import { initializeApp, applicationDefault, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHostedRecoveryApp } from './http-app.mjs';
import { mountObservabilityPreflight } from '../../inference-allowance/services/observability-preflight.mjs';

const project  = process.env.GOOGLE_CLOUD_PROJECT;
const database = process.env.RECOVERY_DATABASE;
const runId    = process.env.RECOVERY_RUN_ID;

if (project !== 'digame-mas' || database !== 'allowance-experiments' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId ?? '') || process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('Explicit hosted experiment target required');

const provenance = JSON.parse(readFileSync(new URL('../../../../deployment-provenance.json', import.meta.url), 'utf8'));
const instanceId = randomUUID(), started = performance.now();
let sequence = 0;

const record = (kind, data = {}) => console.log(JSON.stringify({
    ...data,
    kind,
    runId,
    instanceId,
    role: 'server',
    processId: process.pid,
    localSequence: sequence++,
    localElapsedMs: performance.now() - started,
    revision: process.env.K_REVISION ?? null,
    sourceHash: provenance.sourceHash,
}));

const firebase = initializeApp({ projectId: project, credential: applicationDefault() });
const db       = getFirestore(firebase, database);
const environment = {
    backend:     'firestore-admin',
    production:  true,
    projectId:   project,
    databaseId:  database,
    nodeVersion: process.version,
    sdkVersion:  createRequire(import.meta.url)('firebase-admin').SDK_VERSION,
    sourceHash:  provenance.sourceHash,
    revision:    process.env.K_REVISION ?? null,
};

const service = createHostedRecoveryApp({ db, record, runId, instanceId, environment });
mountObservabilityPreflight(service.app, { db, project, database, record });

const server = service.app.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', error => {
    if (error) throw error;
    record('server-ready', { environment });
});

let stopping = false;
process.on('SIGTERM', async () => {
    if (stopping) return;
    stopping = true;
    service.stopAdmission();
    const deadline = setTimeout(() => { record('shutdown-incomplete', { nativeCommitOutcome: 'unknown' }); process.exit(1); }, 8000);
    await new Promise(resolve => server.close(resolve));
    await service.drain();
    await deleteApp(firebase);
    clearTimeout(deadline);
    record('server-drained');
    process.exit(0);
});
