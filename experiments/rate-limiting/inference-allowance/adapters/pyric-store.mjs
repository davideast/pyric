import { readFileSync } from 'node:fs';
import { pyricBackend } from '../../../shared/backends/pyric.mjs';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore, getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { instrumentStore } from './store.mjs';
export async function createStore({ record, fault = undefined, maxAttempts = 8 }) {
    const sandbox = initializeSandbox();
    setRules(sandbox, readFileSync(new URL('../deployment/firestore.rules', import.meta.url), 'utf8'));
    const db = getAdminFirestore(sandbox.withAuth(null));
    return { clientPut: (uid, path, data) => getFirestore(sandbox.withAuth(uid ? { uid } : null)).doc(`allowanceExperiments/local/cases/case/${path}`).set(data), ...instrumentStore(db, 'allowanceExperiments/local/cases/case', record, { fault, maxAttempts }), close: async () => { } };
}
export const environment = { ...pyricBackend.environment, clock: 'controlled admission clock; process-monotonic durations; scenario-labeled injected faults/delays', backend: 'pyric', transport: 'in-process', authorization: 'public admin sandbox handle, Rules bypass', concurrency: 'optimistic simulator retries; not production pessimistic locking', production: false, capabilities: { clientRules: true } };
