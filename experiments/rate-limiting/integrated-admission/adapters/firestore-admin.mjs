import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { createRequire } from 'node:module';

const segment = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

/**
 * Native Firestore Admin SDK adapter for hosted runs against a dedicated database.
 * Uses the same composite transaction algorithm as the local Pyric adapter.
 * No network calls occur until explicitly instantiated by an approved hosted run.
 */
export async function firestoreFactory(config) {
    if (!segment(config.projectId) || !segment(config.databaseId) || config.databaseId === '(default)')
        throw new Error('Explicit project and dedicated database required');

    const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');

    const app = initializeApp({ projectId: config.projectId, credential: applicationDefault() }, `integrated-${crypto.randomUUID()}`);
    const db  = getFirestore(app, config.databaseId);

    return {
        environment: {
            backend:       'firestore-admin',
            production:    true,
            realInference: false,
            transport:     'grpc',
            projectId:     config.projectId,
            databaseId:    config.databaseId,
            clock:         'controlled by harness for correctness; wall clock for hosted observation',
            sdkVersion:    createRequire(import.meta.url)('firebase-admin').SDK_VERSION,
            authorization: 'Admin SDK with ADC; Rules bypass',
        },
        async createStore({ runId, caseId, record, fault, maxAttempts = 8 }) {
            if (!segment(runId) || !segment(caseId))
                throw new Error('Invalid run namespace');
            const root = `integratedAdmissionExperiments/${runId}/cases/${caseId}`;
            return {
                ...instrumentStore(db, root, record, { fault, maxAttempts }),
                async snapshot() {
                    const cols = ['quotas', 'requests', 'capacity', 'users'];
                    return Object.fromEntries(
                        await Promise.all(cols.map(async name => [
                            name,
                            (await db.collection(`${root}/${name}`).get()).docs.map(doc => ({ id: doc.id, data: doc.data() })),
                        ])),
                    );
                },
                close: async () => {},
            };
        },
        close: () => deleteApp(app),
    };
}
