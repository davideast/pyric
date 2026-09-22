import express from 'express';
import { randomUUID } from 'node:crypto';
import { admit, providerKey } from '../../integrated-admission/architecture/admission.mjs';
import { markDispatching, refund, settle, quarantine } from '../../integrated-admission/architecture/transitions.mjs';
import { claimExpired, renewHeartbeat, selectDueCandidates } from '../architecture/recovery-claim.mjs';
import { reconcile } from '../architecture/reconcile.mjs';
import { POLICIES, LIMITS, RECOVERY_BUDGET } from '../fixtures/contracts.mjs';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { durableProvider } from './provider.mjs';

const operations = [
    'smoke', 'inspect', 'admit', 'dispatch', 'heartbeat',
    'claim', 'reconcile', 'sweep',
    'refund', 'settle', 'quarantine',
    'provider-start', 'provider-finish', 'provider-stop',
    'provider-unavailable', 'provider-hide',
];

export function createHostedRecoveryApp({ db, record, runId, instanceId, environment }) {
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
        policies: POLICIES,
        budget: RECOVERY_BUDGET,
        operations,
        requestCeilingPerInstance: 350,
        requestsObserved: requests,
        clock: 'server wall clock frozen per command; optional explicit logicalTimeMs for controlled recovery',
        evidence: 'deployment target; no real AI calls',
    }));

    app.post('/cases/:caseId/commands', async (req, res) => {
        if (closing || requests >= 350) return res.status(503).json({ error: 'experiment_unavailable' });
        const body = req.body ?? {}, caseId = req.params.caseId;
        if (typeof body !== 'object' || Array.isArray(body)
            || !/^[a-z0-9-]{1,64}$/.test(caseId)
            || !operations.includes(body.operation)
            || Object.keys(body).some(key => ![
                'operation', 'uid', 'requestId', 'category', 'model', 'payloadHash',
                'fence', 'logicalTimeMs', 'outcome', 'owner', 'unavailable', 'hidden', 'batchSize',
            ].includes(key))
            || (body.logicalTimeMs !== undefined && (!Number.isSafeInteger(body.logicalTimeMs) || body.logicalTimeMs < 1000 || body.logicalTimeMs > 1000000000))
            || (['dispatch', 'refund', 'settle', 'quarantine', 'heartbeat', 'reconcile'].includes(body.operation) && (!Number.isSafeInteger(body.fence) || body.fence < 1))
            || (body.operation === 'provider-finish' && !['completed', 'cancelled'].includes(body.outcome))
            || (body.operation === 'smoke' && caseId !== 'deployment-smoke')) {
            return res.status(400).json({ error: 'invalid-command' });
        }
        if (!['inspect', 'sweep'].includes(body.operation) && (typeof body.uid !== 'string' || typeof body.requestId !== 'string'
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
        const root = `automaticRecoveryExperiments/${runId}/cases/${caseId}`;
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
            if (body.operation === 'heartbeat') {
                return renewHeartbeat(store, request, body.fence, { owner, now: () => time, leaseMs: LIMITS.leaseMs }, ctx('heartbeat'));
            }
            if (body.operation === 'claim') {
                return claimExpired(store, request, { owner, now: () => time, leaseMs: LIMITS.leaseMs }, ctx('claim'));
            }
            if (body.operation === 'reconcile') {
                const pKey = providerKey(request.uid, request.requestId);
                const evidence = await provider.observe(pKey);
                return reconcile(store, request, body.fence, evidence, {
                    policies: POLICIES,
                    limits: LIMITS,
                    budget: RECOVERY_BUDGET,
                    now: () => time,
                }, ctx('reconcile'));
            }
            if (body.operation === 'sweep') {
                const allDocs = (await db.collection(`${root}/requests`).get()).docs.map(d => ({ id: d.id, data: d.data() }));
                const pageSize = body.batchSize ?? RECOVERY_BUDGET.batchSize;
                const actions = [];
                let cursor = null;
                while (true) {
                    const res = selectDueCandidates(allDocs, { now: time, pageSize, cursor });
                    if (res.page.length === 0) break;
                    cursor = res.nextCursor;
                    for (const cand of res.page) {
                        const candReq = { uid: cand.uid, requestId: cand.requestId, category: cand.category, model: cand.model };
                        try {
                            const claimRes = await claimExpired(store, candReq, { owner, now: () => time, leaseMs: LIMITS.leaseMs }, {
                                requestId: candReq.requestId, instanceId: owner, uid: candReq.uid, phase: 'sweep-claim',
                            });
                            if (claimRes.status !== 'claimed') {
                                actions.push({ requestId: cand.requestId, claimStatus: claimRes.status });
                                continue;
                            }
                            const pKey = cand.providerKey ?? providerKey(candReq.uid, candReq.requestId);
                            const evidence = await provider.observe(pKey);
                            const recRes = await reconcile(store, candReq, claimRes.record.fence, evidence, {
                                policies: POLICIES,
                                limits: LIMITS,
                                budget: RECOVERY_BUDGET,
                                now: () => time,
                            }, {
                                requestId: candReq.requestId, instanceId: owner, uid: candReq.uid, phase: 'sweep-reconcile',
                            });
                            actions.push({ requestId: cand.requestId, claimStatus: 'claimed', action: recRes.action, state: recRes.record.state });
                        } catch (error) {
                            actions.push({ requestId: cand.requestId, error: error.code ?? error.message });
                        }
                    }
                    if (!cursor) break;
                }
                return { swept: actions.length, actions };
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
            if (body.operation === 'provider-stop') {
                return provider.stop(providerKey(request.uid, request.requestId));
            }
            if (body.operation === 'provider-unavailable') {
                return provider.unavailable(providerKey(request.uid, request.requestId), body.unavailable ?? true);
            }
            if (body.operation === 'provider-hide') {
                return provider.hide(providerKey(request.uid, request.requestId), body.hidden ?? true);
            }
            if (body.operation === 'settle') {
                const pKey = providerKey(request.uid, request.requestId);
                const evidence = await provider.observe(pKey);
                return settle(store, request, body.fence, evidence, ctx('settle'));
            }
            // 'smoke': full admit -> dispatch -> provider-start -> provider-finish -> claim -> reconcile lifecycle
            const admitted = await admit(store, request, { policies: POLICIES, limits: LIMITS, owner, now: () => time }, ctx('admission'));
            if (admitted.status !== 'admitted') return admitted;
            const dispatching = await markDispatching(store, request, admitted.record.fence, ctx('dispatch'));
            await provider.start(dispatching.providerKey, request.uid);
            await provider.finish(dispatching.providerKey, 'completed');
            const expiredTime = time + LIMITS.leaseMs + 1000;
            const claimed = await claimExpired(store, request, { owner: `recovery-${owner}`, now: () => expiredTime, leaseMs: LIMITS.leaseMs }, ctx('smoke-claim'));
            const evidence = await provider.observe(dispatching.providerKey);
            const reconciled = await reconcile(store, request, claimed.record.fence, evidence, {
                policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => expiredTime,
            }, { requestId: request.requestId, instanceId: `recovery-${owner}`, uid: request.uid, phase: 'smoke-reconcile' });
            return { status: 'completed', record: reconciled.record, action: reconciled.action };
        };

        const tracked = execute();
        inFlight.add(tracked);
        try {
            const output = await tracked;
            trace('request-complete', { operation: body.operation, status: output?.status ?? output?.action ?? 'ok' });
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
