import express from 'express';
import { randomUUID } from 'node:crypto';
import { admit, providerKey } from '../architecture/admission.mjs';
import { markDispatching, refund, settle, quarantine } from '../architecture/transitions.mjs';
import { POLICIES, LIMITS } from '../fixtures/policy.mjs';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { durableProvider } from './provider.mjs';

const operations = [
    'smoke', 'inspect', 'admit', 'dispatch', 'start',
    'refund', 'settle', 'quarantine', 'provider-start', 'provider-finish', 'provider-hide',
];

// Cloud Run IAM authenticates the operator. This is a private experiment control
// API, not a Firebase Auth endpoint or an internet-facing inference gateway.
export function createHostedIntegratedApp({ db, record, runId, instanceId, environment }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !instanceId || !environment?.backend)
        throw new Error('Explicit experiment identity required');

    const app = express(), inFlight = new Set();
    let closing = false, requests = 0;
    app.disable('x-powered-by');
    app.use(express.json({ limit: '4kb', strict: true }));

    app.get('/health', (_req, res) => res.status(closing ? 503 : 200).json({
        ...environment,
        runId,
        instanceId,
        inference: 'durable fixture; no real model calls',
        authentication: 'Cloud Run IAM operator; synthetic actors',
        limits: LIMITS,
        policies: POLICIES,
        operations,
        requestCeilingPerInstance: 250,
        requestsObserved: requests,
        clock: 'server wall clock frozen per command; optional explicit logicalTimeMs for controlled recovery',
        evidence: 'deployment target; no real AI calls',
    }));

    app.post('/cases/:caseId/commands', async (req, res) => {
        if (closing || requests >= 250) return res.status(503).json({ error: 'experiment_unavailable' });
        const body = req.body ?? {}, caseId = req.params.caseId;
        if (typeof body !== 'object' || Array.isArray(body)
            || !/^[a-z0-9-]{1,64}$/.test(caseId)
            || !operations.includes(body.operation)
            || Object.keys(body).some(key => !['operation', 'uid', 'requestId', 'category', 'model', 'payloadHash', 'fence', 'logicalTimeMs', 'outcome', 'owner'].includes(key))
            || (body.logicalTimeMs !== undefined && (!Number.isSafeInteger(body.logicalTimeMs) || body.logicalTimeMs < 1000 || body.logicalTimeMs > 1000000000))
            || (['dispatch', 'refund', 'settle', 'quarantine'].includes(body.operation) && (!Number.isSafeInteger(body.fence) || body.fence < 1))
            || (body.operation === 'provider-finish' && !['completed', 'cancelled'].includes(body.outcome))
            || (body.operation === 'smoke' && caseId !== 'deployment-smoke')) {
            return res.status(400).json({ error: 'invalid-command' });
        }
        if (body.operation !== 'inspect' && (typeof body.uid !== 'string' || typeof body.requestId !== 'string'
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
        };
        const owner = body.owner ?? instanceId;
        const attemptId = randomUUID();
        const trace = (kind, data = {}) => record(kind, { ...data, ...request, caseId, instanceId, attemptId });
        const root = `integratedAdmissionExperiments/${runId}/cases/${caseId}`;
        const store = instrumentStore(db, root, trace, { maxAttempts: 8 });
        const provider = durableProvider(store, { ...request, instanceId: owner }, trace);
        const time = body.logicalTimeMs ?? Date.now();
        const ctx = phase => ({ requestId: request.requestId, instanceId: owner, uid: request.uid, phase });

        trace('command-received', { operation: body.operation, clockMs: time, controlledClock: body.logicalTimeMs !== undefined });
        trace('request-start', { operation: body.operation });

        const execute = async () => {
            if (body.operation === 'inspect') {
                return Object.fromEntries(await Promise.all(['quotas', 'requests', 'capacity', 'users', 'provider'].map(async name => [
                    name,
                    (await db.collection(`${root}/${name}`).get()).docs.map(doc => ({ id: doc.id, data: doc.data() })),
                ])));
            }
            if (body.operation === 'admit') {
                return admit(store, request, { policies: POLICIES, limits: LIMITS, owner, now: () => time }, ctx('admission'));
            }
            if (body.operation === 'dispatch') {
                return markDispatching(store, request, body.fence, ctx('dispatch'));
            }
            if (body.operation === 'refund') {
                return refund(store, request, body.fence, { policies: POLICIES, limits: LIMITS, now: () => time }, ctx('refund'));
            }
            if (body.operation === 'quarantine') {
                return quarantine(store, request, body.fence, ctx('quarantine'));
            }
            if (body.operation === 'provider-start') {
                return provider.start(providerKey(request.uid, request.requestId), request.uid);
            }
            if (body.operation === 'provider-finish') {
                return provider.finish(providerKey(request.uid, request.requestId), body.outcome);
            }
            if (body.operation === 'provider-hide') {
                return provider.hide(providerKey(request.uid, request.requestId));
            }
            if (body.operation === 'settle') {
                const pKey = providerKey(request.uid, request.requestId);
                const evidence = await provider.observe(pKey);
                return settle(store, request, body.fence, evidence, ctx('settle'));
            }
            // 'start' or 'smoke': full lifecycle
            const admitted = await admit(store, request, { policies: POLICIES, limits: LIMITS, owner, now: () => time }, ctx('admission'));
            if (admitted.status !== 'admitted') return admitted;
            const dispatching = await markDispatching(store, request, admitted.record.fence, ctx('dispatch'));
            await provider.start(dispatching.providerKey, request.uid);
            await provider.finish(dispatching.providerKey, 'completed');
            const evidence = await provider.observe(dispatching.providerKey);
            const settled = await settle(store, request, dispatching.fence, evidence, ctx('settle'));
            return { status: 'completed', record: settled };
        };

        const pending = execute();
        inFlight.add(pending);
        try {
            const result = await pending;
            trace('command-complete', { operation: body.operation });
            return res.json({ result, instanceId, runId, caseId });
        } catch (error) {
            const code = String(error.code ?? error.message);
            trace('command-error', { operation: body.operation, code });
            return res.status(409).json({ error: code, instanceId, runId, caseId });
        } finally {
            inFlight.delete(pending);
            trace('request-work-settled', { operation: body.operation });
        }
    });

    app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid-request' }));
    return { app, stopAdmission() { closing = true; }, async drain() { await Promise.allSettled([...inFlight]); } };
}
