import express from 'express';
import { randomUUID } from 'node:crypto';
import { providerKey } from '../../integrated-admission/architecture/admission.mjs';
import { markDispatching, settle, quarantine } from '../../integrated-admission/architecture/transitions.mjs';
import { admitImmediate } from '../architecture/immediate.mjs';
import { enqueue, cancelQueued, expireQueued } from '../architecture/queue.mjs';
import { selectNextFifo } from '../architecture/fifo.mjs';
import { selectNextRoundRobin } from '../architecture/round-robin.mjs';
import { LIMITS, QUEUE_LIMITS, POLICIES, LOW_ALLOWANCE_POLICIES } from '../fixtures/workloads.mjs';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { durableProvider } from './provider.mjs';

const operations = [
    'smoke', 'inspect',
    'admit-immediate', 'enqueue', 'cancel-queued', 'expire-queued',
    'select-fifo', 'select-round-robin',
    'settle', 'quarantine',
    'provider-finish', 'provider-hide',
];

export function createHostedFairAllocationApp({ db, record, runId, instanceId, environment }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !instanceId || !environment?.backend)
        throw new Error('Explicit experiment identity required');

    const app = express(), inFlight = new Set();
    let closing = false, requests = 0;
    app.disable('x-powered-by');
    app.use(express.json({ limit: '8kb', strict: true }));

    app.get('/health', (_req, res) => res.status(closing ? 503 : 200).json({
        ...environment,
        runId,
        instanceId,
        inference: 'durable fixture; no real model calls',
        authentication: 'Cloud Run IAM operator; synthetic actors',
        limits: LIMITS,
        queueLimits: QUEUE_LIMITS,
        policies: POLICIES,
        operations,
        requestCeilingPerInstance: 400,
        requestsObserved: requests,
        clock: 'server wall clock frozen per command; optional explicit logicalTimeMs for controlled scheduling',
        evidence: 'deployment target; no real AI calls',
    }));

    app.post('/cases/:caseId/commands', async (req, res) => {
        if (closing || requests >= 400) return res.status(503).json({ error: 'experiment_unavailable' });
        const body = req.body ?? {}, caseId = req.params.caseId;
        if (typeof body !== 'object' || Array.isArray(body)
            || !/^[a-z0-9-]{1,64}$/.test(caseId)
            || !operations.includes(body.operation)
            || Object.keys(body).some(key => ![
                'operation', 'uid', 'requestId', 'category', 'model', 'payloadHash', 'durationMs',
                'fence', 'logicalTimeMs', 'outcome', 'owner', 'hidden', 'lowAllowance',
            ].includes(key))
            || (body.logicalTimeMs !== undefined && (!Number.isSafeInteger(body.logicalTimeMs) || body.logicalTimeMs < 1000 || body.logicalTimeMs > 1000000000))
            || (['settle', 'quarantine'].includes(body.operation) && (!Number.isSafeInteger(body.fence) || body.fence < 1))
            || (body.operation === 'provider-finish' && !['completed', 'cancelled'].includes(body.outcome))
            || (body.operation === 'smoke' && caseId !== 'deployment-smoke')) {
            return res.status(400).json({ error: 'invalid-command' });
        }
        if (!['inspect', 'select-fifo', 'select-round-robin'].includes(body.operation) && (typeof body.uid !== 'string' || typeof body.requestId !== 'string'
            || !/^[a-z0-9-]{1,50}$/.test(body.uid) || !/^[a-z0-9-]{1,100}$/.test(body.requestId))) {
            return res.status(400).json({ error: 'invalid-actor-or-request' });
        }

        requests++;
        const request = {
            uid:         body.uid ?? null,
            requestId:   body.requestId ?? null,
            category:    body.category ?? 'chat',
            model:       body.model ?? 'fake',
            payloadHash: body.payloadHash ?? 'default-hash',
            durationMs:  body.durationMs ?? 200,
        };
        const activePolicies = body.lowAllowance ? LOW_ALLOWANCE_POLICIES : POLICIES;
        const owner = body.owner ?? instanceId;
        const attemptId = randomUUID();
        const trace = (kind, data = {}) => record(kind, { ...data, ...request, caseId, instanceId, attemptId });
        const root = `fairAllocationExperiments/${runId}/cases/${caseId}`;
        const store = instrumentStore(db, root, trace, { maxAttempts: 8 });
        const provider = durableProvider(store, { ...request, instanceId: owner }, trace);
        const time = body.logicalTimeMs ?? Date.now();
        const ctx = phase => ({ requestId: request.requestId, instanceId: owner, uid: request.uid, phase });

        trace('command-received', { operation: body.operation, clockMs: time, controlledClock: body.logicalTimeMs !== undefined });
        trace('request-start', { operation: body.operation });

        const execute = async () => {
            if (body.operation === 'inspect') {
                return Object.fromEntries(await Promise.all(['quotas', 'requests', 'capacity', 'users', 'queue', 'queueMeta', 'cursor', 'provider'].map(async name => [
                    name,
                    (await db.collection(`${root}/${name}`).get()).docs.map(doc => ({ id: doc.id, data: doc.data() })),
                ])));
            }
            if (body.operation === 'admit-immediate') {
                const res = await admitImmediate(store, request, { policies: activePolicies, limits: LIMITS, owner, now: () => time }, ctx('admit-immediate'));
                if (res.status === 'execution-admitted') {
                    const dispatching = await markDispatching(store, request, res.record.fence, ctx('dispatch-immediate'));
                    await provider.start(dispatching.providerKey, request.uid, request.durationMs);
                    return { status: 'execution-admitted', record: dispatching };
                }
                return res;
            }
            if (body.operation === 'enqueue') {
                return enqueue(store, request, { queueLimits: QUEUE_LIMITS, now: () => time }, ctx('enqueue'));
            }
            if (body.operation === 'cancel-queued') {
                return cancelQueued(store, request, ctx('cancel-queued'));
            }
            if (body.operation === 'expire-queued') {
                return expireQueued(store, request, { now: () => time }, ctx('expire-queued'));
            }
            if (body.operation === 'select-fifo' || body.operation === 'select-round-robin') {
                const candidates = (await db.collection(`${root}/queue`).get()).docs.map(d => d.data());
                const selector = body.operation === 'select-round-robin' ? selectNextRoundRobin : selectNextFifo;
                const sel = await selector(store, candidates, { limits: LIMITS, policies: activePolicies, owner, now: () => time }, ctx(body.operation));
                if (sel.status === 'execution-admitted') {
                    await provider.start(sel.record.providerKey, sel.record.uid, sel.record.durationMs ?? 200);
                }
                return sel;
            }
            if (body.operation === 'settle') {
                const pKey = providerKey(request.uid, request.requestId);
                const evidence = await provider.observe(pKey);
                return settle(store, request, body.fence, evidence, ctx('settle'));
            }
            if (body.operation === 'quarantine') {
                return quarantine(store, request, body.fence, ctx('quarantine'));
            }
            if (body.operation === 'provider-finish') {
                return provider.finish(providerKey(request.uid, request.requestId), body.outcome);
            }
            if (body.operation === 'provider-hide') {
                return provider.hide(providerKey(request.uid, request.requestId), body.hidden ?? true);
            }
            // 'smoke'
            const enq = await enqueue(store, request, { queueLimits: QUEUE_LIMITS, now: () => time }, ctx('smoke-enqueue'));
            const candidates = (await db.collection(`${root}/queue`).get()).docs.map(d => d.data());
            const sel = await selectNextRoundRobin(store, candidates, { limits: LIMITS, policies: POLICIES, owner, now: () => time }, ctx('smoke-select'));
            await provider.start(sel.record.providerKey, request.uid, 200);
            await provider.finish(sel.record.providerKey, 'completed');
            const evidence = await provider.observe(sel.record.providerKey);
            const settled = await settle(store, request, sel.record.fence, evidence, ctx('smoke-settle'));
            return { status: 'completed', enqueued: enq.status, record: settled };
        };

        const tracked = execute();
        inFlight.add(tracked);
        try {
            const output = await tracked;
            trace('request-complete', { operation: body.operation, status: output?.status ?? 'ok' });
            res.status(200).json({ runId, instanceId, caseId, operation: body.operation, output });
        } catch (error) {
            const code = error.code ?? error.message ?? 'internal';
            trace('request-error', { operation: body.operation, error: code });
            res.status(409).json({ runId, instanceId, caseId, operation: body.operation, error: code });
        } finally {
            inFlight.delete(tracked);
        }
    });

    return {
        app,
        stopAdmission() { closing = true; },
        async drain() { await Promise.allSettled([...inFlight]); },
    };
}
