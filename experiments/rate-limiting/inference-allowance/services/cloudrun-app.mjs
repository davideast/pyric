import express from 'express';
import { createGateway } from '../architecture/gateway.mjs';
import { fakeInference } from './fake-inference.mjs';
import policies from '../fixtures/policies.json' with { type: 'json' };

// Cloud Run IAM authenticates the experiment operator. This header selects a
// synthetic actor; it is deliberately NOT an end-user authentication protocol.
export function createHostedApp({ store, record, runId, instanceId, environment, deadlineMs = 2000 }) {
    if (!environment?.backend) throw new Error('Backend provenance required');
    const gateway = createGateway({ store, record, policies, clock: { now: () => Date.now() }, instanceId,
        maxOutstandingPerUid: 2, maxOutstanding: 16, deadlineMs,
        authenticate: async uid => /^(alice|bob|carol|dave|eve|user(?:[0-9]|1[0-9]))$/.test(uid ?? '') ? uid : null,
        inference: fakeInference(record) });
    const app = express();
    let requests = 0, closing = false;
    app.disable('x-powered-by');
    app.use(express.json({ limit: '4kb', strict: true }));
    app.get('/health', (_, res) => res.status(closing ? 503 : 200).json({ ...environment, runId, instanceId,
        inference: 'fake', authentication: 'Cloud Run IAM operator; synthetic user header',
        clock: 'server wall clock', maxOutstandingPerUid: 2, maxOutstanding: 16,
        requestCeilingPerInstance: 250, requestsObserved: requests }));
    app.post('/infer/:route', async (req, res) => {
        if (closing || requests >= 250) return res.status(503).json({ status: 'experiment_unavailable' });
        requests++;
        const requestId = req.body?.requestId;
        record('http-received', { requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null });
        res.on('close', () => record('http-closed', { requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null, finished: res.writableFinished }));
        const result = await gateway.request({ token: req.get('X-Experiment-User'), route: req.params.route, body: req.body });
        const httpStatus = { completed: 200, quota_exhausted: 429, admission_busy: 503, admission_timeout: 504,
            unauthenticated: 401, invalid_request: 400, duplicate: 200, conflict: 409 }[result.status] ?? 500;
        record('http-response', { requestId: typeof requestId === 'string' ? requestId.slice(0, 100) : null, status: result.status, httpStatus });
        if (!res.destroyed) res.status(httpStatus).json(result);
    });
    app.use((error, _req, res, _next) => {
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ status: 'invalid_request' });
    });
    return { app, drain: () => gateway.drain(), stopAdmission: () => { closing = true; } };
}
