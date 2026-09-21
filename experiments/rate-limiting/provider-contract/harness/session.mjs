import { randomUUID } from 'node:crypto';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { terminalEvidence } from '../architecture/termination-evidence.mjs';
import { spawnPeer } from '../services/process-peer.mjs';

export async function createSession({ runId, caseId, record, profile = 'observable', unsafe = false, maxDispatches = 2, maxConcurrent = 1, chargeCommand = () => {} }) {
    const db = getAdminFirestore(initializeSandbox().withAuth(null));
    const store = instrumentStore(db, `providerContractExperiments/${runId}/cases/${caseId}`, record);
    const boundedPeer = async (url, handlers = {}) => {
        const worker = await spawnPeer(url, Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, args => { chargeCommand(); return handler(args); }])));
        return { ...worker, call: (...args) => { chargeCommand(); return worker.call(...args); } };
    };
    const provider = await boundedPeer(new URL('../services/provider-oracle.mjs', import.meta.url));
    try {
    const { url } = await provider.call('configure', { profile });
    const workers = []; const observations = [];
    await store.put('state/budget', { active: 0, dispatches: 0, releases: 0 });
    const context = requestId => ({ requestId, uid: 'alice', attemptId: randomUUID(), instanceId: 'gateway', phase: 'provider-contract' });
    async function spawnGateway() {
        const gateway = await boundedPeer(new URL('../services/gateway.mjs', import.meta.url), {
            reserve: async ({ requestId, uid }) => store.transaction(context(requestId), async tx => {
                const budget = await tx.get('state/budget'); const existing = await tx.get('requests/' + requestId);
                if (existing) return { allowed: false, status: 'duplicate' };
                if (budget.active >= maxConcurrent || budget.dispatches >= maxDispatches) return { allowed: false, status: 'budget-exhausted' };
                tx.put('state/budget', { ...budget, active: budget.active + 1 });
                tx.put('requests/' + requestId, { uid, state: 'reserved', released: false, providerOperationId: null });
                return { allowed: true };
            }),
            dispatch: async ({ requestId }) => store.transaction(context(requestId), async tx => {
                const budget = await tx.get('state/budget'); const request = await tx.get('requests/' + requestId);
                if (budget.dispatches >= maxDispatches || request.state !== 'reserved') throw new Error('dispatch-budget-exhausted');
                tx.put('state/budget', { ...budget, dispatches: budget.dispatches + 1 });
                tx.put('requests/' + requestId, { ...request, state: 'unknown' });
                record('dispatch-intent', { requestId }); return { charged: true };
            }),
            observation: async ({ requestId, observation }) => {
                observations.push({ requestId, ...observation }); record('provider-observation', { requestId, ...observation });
                return store.transaction(context(requestId), async tx => {
                    const request = await tx.get('requests/' + requestId); const budget = await tx.get('state/budget');
                    if (!request || request.released) return { ignored: true };
                    if (request.providerOperationId && observation.providerOperationId && request.providerOperationId !== observation.providerOperationId) return { ignored: true, reason: 'operation-mismatch' };
                    const terminal = terminalEvidence(observation);
                    const release = !!terminal || (unsafe && ['unknown', 'transport-closed'].includes(observation.status));
                    tx.put('requests/' + requestId, { ...request, providerOperationId: observation.providerOperationId ?? request.providerOperationId,
                        state: terminal ?? (observation.status === 'accepted' ? 'running' : ['unknown', 'transport-closed'].includes(observation.status) ? 'unknown' : request.state), released: release });
                    if (release) tx.put('state/budget', { ...budget, active: budget.active - 1, releases: budget.releases + 1 });
                    return { release };
                });
            },
        });
        workers.push(gateway); await gateway.call('init', { url }); return gateway;
    }
    const gateway = await spawnGateway();
    return { provider, gateway, observations, spawnGateway,
        async snapshot() { const oracle = await provider.call('snapshot'); record('oracle-snapshot', { source: 'fixture-oracle', oracle }); return { reservation: { ...await store.get('state/budget'), requests: (await db.collection(`providerContractExperiments/${runId}/cases/${caseId}/requests`).get()).docs.map(d => ({ id: d.id, ...d.data() })) }, oracle }; },
        async wait(check) { const until = Date.now() + 4000; while (Date.now() < until) { const value = await this.snapshot(); if (check(value)) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('barrier-timeout'); },
        async close() { await Promise.allSettled(workers.map(w => w.kill())); await provider.kill(); },
    };
    } catch (error) { await provider.kill(); throw error; }
}
