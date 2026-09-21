import { readFileSync } from 'node:fs';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { pyricBackend } from '../../../shared/backends/pyric.mjs';

/**
 * Creates an instrumented Admin Firestore store backed by the Pyric sandbox.
 * Used for local experiment runs. Rules are applied but the Admin SDK bypasses them.
 *
 * @param {{ runId: string, caseId: string, record: (kind: string, data: object) => void, fault?: Function, maxAttempts?: number }} opts
 */
export async function createPyricStore({ runId, caseId, record, fault, maxAttempts = 8 }) {
    const sandbox = initializeSandbox();
    setRules(sandbox, readFileSync(new URL('../architecture/firestore.rules', import.meta.url), 'utf8'));
    const db = getAdminFirestore(sandbox.withAuth(null));
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
}

export const environment = {
    ...pyricBackend.environment,
    backend:       'pyric',
    transport:     'in-process',
    clock:         'logical milliseconds advanced at barriers; frozen per command',
    authorization: 'admin sandbox handle, Rules bypass',
    production:    false,
    realInference: false,
    limitations: [
        'No hosted Firestore measurement or pessimistic-locking/throughput claim',
        'A single parent process owns Pyric; gateway workers execute over IPC',
        'Provider status and remote activity are a fixture, not real AI Logic confirmation',
        'No autoscaling, clock-skew, or automatic reaper is validated',
    ],
};
