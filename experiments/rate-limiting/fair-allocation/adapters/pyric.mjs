import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { markDispatching, settle, quarantine } from '../../integrated-admission/architecture/transitions.mjs';
import { admitImmediate } from '../architecture/immediate.mjs';
import { enqueue, cancelQueued, expireQueued } from '../architecture/queue.mjs';
import { selectNextFifo } from '../architecture/fifo.mjs';
import { selectNextRoundRobin } from '../architecture/round-robin.mjs';
import { LIMITS, QUEUE_LIMITS, POLICIES } from '../fixtures/workloads.mjs';
import { createProviderOracle } from '../services/provider-oracle.mjs';

export async function createFairAllocationCluster({
    caseId,
    runId = 'local-run',
    limits = LIMITS,
    queueLimits = QUEUE_LIMITS,
    policies = POLICIES,
    recordEvent = () => {},
} = {}) {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox.withAuth(null));
    const root = `fairAllocationExperiments/${runId}/cases/${caseId}`;
    const events = [];
    const trace = (kind, data = {}) => {
        const entry = { kind, caseId, ...data };
        events.push(entry);
        recordEvent(entry);
    };
    const store = instrumentStore(db, root, trace, { maxAttempts: 8 });
    const provider = createProviderOracle();
    let clockMs = 1_000;

    const now = () => clockMs;
    const advance = deltaMs => { clockMs += deltaMs; return clockMs; };
    const setTime = ts => { clockMs = ts; return clockMs; };

    const listCollection = async name =>
        (await db.collection(`${root}/${name}`).get()).docs.map(d => ({ id: d.id, data: d.data() }));

    return {
        db,
        store,
        provider,
        now,
        advance,
        setTime,
        events,

        async admitImmediate(request, owner = 'gw-1') {
            const ctx = { requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'immediate-admit' };
            const res = await admitImmediate(store, request, { policies, limits, owner, now }, ctx);
            if (res.status === 'execution-admitted') {
                const dispatching = await markDispatching(store, request, res.record.fence, {
                    requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'immediate-dispatch',
                });
                provider.start(dispatching.providerKey, request.uid, {
                    durationMs: request.durationMs ?? 200,
                    startedAt: now(),
                });
                return { status: 'execution-admitted', record: dispatching };
            }
            return res;
        },

        async enqueue(request, owner = 'gw-1') {
            const ctx = { requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'enqueue' };
            return enqueue(store, request, { queueLimits, now }, ctx);
        },

        async cancelQueued(request, owner = 'gw-1') {
            const ctx = { requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'cancel-queued' };
            return cancelQueued(store, request, ctx);
        },

        async expireQueued(request, owner = 'gw-1') {
            const ctx = { requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'expire-queued' };
            return expireQueued(store, request, { now }, ctx);
        },

        async selectNext(variant, owner = 'disp-1') {
            const queueDocs = (await listCollection('queue')).map(d => d.data);
            const ctx = { instanceId: owner, phase: `select-${variant}` };
            const selector = variant === 'round-robin' ? selectNextRoundRobin : selectNextFifo;
            const res = await selector(store, queueDocs, { limits, policies, owner, now }, ctx);
            if (res.status === 'execution-admitted') {
                provider.start(res.record.providerKey, res.record.uid, {
                    durationMs: res.record.durationMs ?? 200,
                    startedAt: now(),
                });
            }
            return res;
        },

        async settleDueJobs(owner = 'disp-1') {
            const due = provider.dueRunning(now());
            const settled = [];
            for (const job of due) {
                provider.finish(job.key, 'completed', now());
                const reqDocs = await listCollection('requests');
                const match = reqDocs.find(d => d.data.providerKey === job.key);
                if (match && match.data.state === 'dispatching') {
                    const evidence = provider.observe(job.key);
                    const res = await settle(
                        store,
                        { uid: match.data.uid, requestId: match.data.requestId },
                        match.data.fence,
                        evidence,
                        { requestId: match.data.requestId, instanceId: match.data.owner ?? owner, uid: match.data.uid, phase: 'settle' },
                    );
                    settled.push(res);
                }
            }
            return settled;
        },

        async quarantineJob(request, fence, owner = 'disp-1') {
            return quarantine(store, request, fence, {
                requestId: request.requestId, instanceId: owner, uid: request.uid, phase: 'quarantine',
            });
        },

        async snapshot() {
            const [quotas, requests, capacity, users, queue, queueMeta, cursor] = await Promise.all([
                listCollection('quotas'),
                listCollection('requests'),
                listCollection('capacity'),
                listCollection('users'),
                listCollection('queue'),
                listCollection('queueMeta'),
                listCollection('cursor'),
            ]);
            return {
                quotas,
                requests,
                capacity,
                users,
                queue,
                queueMeta,
                cursor,
                oracle: provider.snapshot(),
            };
        },
    };
}
