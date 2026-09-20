import { instrumentStore } from './store.mjs';
import { preflight } from './preflight.mjs';
import { createRequire } from 'node:module';
const segment = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
// No network work occurs until the caller explicitly selects this factory.
export async function firestoreFactory(config) {
    if (!segment(config.projectId) || !segment(config.databaseId) || config.databaseId === '(default)')
        throw new Error('Explicit project and dedicated database required');
    const target = await preflight(config, { probe: true });
    if (!target.ready)
        throw new Error('Hosted preflight failed: database metadata must be verified before writes');
    const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = initializeApp({ projectId: config.projectId, credential: applicationDefault() }, `allowance-${crypto.randomUUID()}`);
    const db = getFirestore(app, config.databaseId);
    return {
        environment: { backend: 'firestore-admin', production: true, transport: 'grpc', projectId: config.projectId, databaseId: config.databaseId, clock: 'controlled by harness for correctness; not real admission time', database: target.database, concurrency: target.database.concurrencyMode, sdkVersion: createRequire(import.meta.url)('firebase-admin').SDK_VERSION, authorization: 'Admin SDK with ADC; Rules bypass', capabilities: { clientRules: false } },
        async createStore({ runId, caseId, record, fault, maxAttempts }) {
            if (!segment(runId) || !segment(caseId))
                throw new Error('Invalid run namespace');
            const root = `allowanceExperiments/${runId}/cases/${caseId}`;
            return { ...instrumentStore(db, root, record, { fault, maxAttempts }), close: async () => { }, clientPut: async () => { throw Object.assign(new Error('Authenticated Web SDK actor not configured'), { code: 'unsupported' }); } };
        },
        // Records remain isolated for inspection. Deletion is a separate supervised action.
        close: () => deleteApp(app),
    };
}
