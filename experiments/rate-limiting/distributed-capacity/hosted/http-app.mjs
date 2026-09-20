import express from 'express';
import { randomUUID } from 'node:crypto';
import { createCapacity } from '../architecture/capacity.mjs';
import { instrumentStore } from '../../inference-allowance/adapters/store.mjs';
import { durableProvider } from './provider.mjs';

const cases = ['deployment-smoke', 'capacity-shared', 'recovery'];
const limits = { global: 3, perUser: 2, leaseMs: 30000 };
const operations = ['smoke', 'inspect', 'reserve', 'start', 'resume', 'intent', 'takeover', 'renew', 'reconcile', 'provider-finish'];

// Cloud Run IAM authenticates the operator. This is a private experiment control
// API, not a Firebase Auth endpoint or an internet-facing inference gateway.
export function createHostedCapacityApp({ db, record, runId, instanceId, environment }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !instanceId || !environment?.backend) throw new Error('Explicit experiment identity required');
    const app = express(), inFlight = new Set();
    let closing = false, requests = 0;
    app.disable('x-powered-by'); app.use(express.json({ limit: '4kb', strict: true }));
    app.get('/health', (_req, res) => res.status(closing ? 503 : 200).json({ ...environment, runId, instanceId,
        inference: 'durable fixture; no real model calls', authentication: 'Cloud Run IAM operator; synthetic actors',
        limits, cases, operations, requestCeilingPerInstance: 250, requestsObserved: requests,
        clock: 'server wall clock frozen per command; optional explicit logicalTimeMs for controlled recovery',
        evidence: 'deployment target; no hosted experiment assessment yet' }));
    app.post('/cases/:caseId/commands', async (req, res) => {
        if (closing || requests >= 250) return res.status(503).json({ error: 'experiment_unavailable' });
        const body = req.body ?? {}, caseId = req.params.caseId;
        if (typeof body !== 'object' || Array.isArray(body) || !cases.includes(caseId) || !operations.includes(body.operation)
            || Object.keys(body).some(key => !['operation', 'uid', 'requestId', 'fence', 'logicalTimeMs', 'outcome'].includes(key))
            || (body.logicalTimeMs !== undefined && (!Number.isSafeInteger(body.logicalTimeMs) || body.logicalTimeMs < 1000 || body.logicalTimeMs > 1000000000))
            || (['resume', 'intent', 'renew', 'reconcile'].includes(body.operation) && (!Number.isSafeInteger(body.fence) || body.fence < 1))
            || (body.operation === 'provider-finish' && !['completed', 'cancelled'].includes(body.outcome))
            || (body.operation === 'smoke' && caseId !== 'deployment-smoke')) return res.status(400).json({ error: 'invalid-command' });
        if (body.operation !== 'inspect' && (typeof body.uid !== 'string' || typeof body.requestId !== 'string' || !/^(alice|bob|carol|dave)$/.test(body.uid) || !/^[a-z0-9-]{1,100}$/.test(body.requestId))) return res.status(400).json({ error: 'invalid-actor-or-request' });
        requests++;
        const request = { uid: body.uid ?? null, requestId: body.requestId ?? null };
        const attemptId = randomUUID();
        const trace = (kind, data = {}) => record(kind, { ...data, ...request, caseId, instanceId, attemptId });
        const root = `capacityExperiments/${runId}/cases/${caseId}`;
        const store = instrumentStore(db, root, trace, { maxAttempts: 8 });
        const provider = durableProvider(store, { ...request, instanceId }, trace);
        const time = body.logicalTimeMs ?? Date.now();
        const capacity = createCapacity({ store, owner: instanceId, now: () => time, limits });
        trace('command-received', { operation: body.operation, clockMs: time, controlledClock: body.logicalTimeMs !== undefined });
        trace('request-start', { operation: body.operation });
        const execute = async () => {
            if (body.operation === 'inspect') return Object.fromEntries(await Promise.all(['capacity', 'users', 'requests', 'provider'].map(async name => [name,
                (await db.collection(`${root}/${name}`).get()).docs.map(doc => ({ id: doc.id, data: doc.data() }))])));
            if (body.operation === 'reserve') return capacity.reserve(request);
            if (body.operation === 'takeover') return capacity.takeover(request);
            if (body.operation === 'renew') return capacity.renew(request, body.fence);
            if (body.operation === 'intent') return capacity.dispatch(request, body.fence);
            if (body.operation === 'reconcile' || body.operation === 'provider-finish') {
                const saved = await capacity.get(request);
                if (!saved) throw new Error('missing-reservation');
                if (body.operation === 'provider-finish') return provider.finish(saved.providerKey, body.outcome);
                return capacity.observe(request, body.fence, await provider.observe(saved.providerKey));
            }
            if (body.operation === 'resume') {
                const intent = await capacity.dispatch(request, body.fence);
                await provider.start(intent.providerKey, request.uid);
                return { status: 'started', record: await capacity.observe(request, intent.fence, await provider.observe(intent.providerKey)) };
            }
            const reservation = await capacity.reserve(request);
            if (reservation.status !== 'reserved') return reservation;
            const intent = await capacity.dispatch(request, reservation.record.fence);
            await provider.start(intent.providerKey, request.uid);
            if (body.operation === 'smoke') await provider.finish(intent.providerKey, 'completed');
            const record = await capacity.observe(request, intent.fence, await provider.observe(intent.providerKey));
            return { status: body.operation === 'smoke' ? 'completed' : 'started', record };
        };
        const pending = execute(); inFlight.add(pending);
        try {
            const result = await pending;
            trace('command-complete', { operation: body.operation });
            return res.json({ result, instanceId, runId, caseId });
        } catch (error) {
            const code = String(error.code ?? error.message);
            trace('command-error', { operation: body.operation, code });
            return res.status(409).json({ error: code, instanceId, runId, caseId });
        } finally { inFlight.delete(pending); trace('request-work-settled', { operation: body.operation }); }
    });
    app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid-request' }));
    return { app, stopAdmission() { closing = true; }, async drain() { await Promise.allSettled([...inFlight]); } };
}
