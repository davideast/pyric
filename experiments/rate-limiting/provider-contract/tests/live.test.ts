import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { runLiveCases } from '../live/workload.mjs';

const config = { projectId: 'fixture-project', databaseId: 'fixture-database', appId: 'fixture-app', model: 'fixture-model',
    limits: { maxDispatches: 3, maxConcurrent: 2, maxOutputTokens: 64, requestDeadlineMs: 1000, runDeadlineMs: 10000 } };

test('live workflow shares a durable budget across cases and keeps interrupted work after restart', async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
        for await (const _ of req) { /* consume request without retaining prompt */ }
        requests++;
        if (!req.url?.includes('streamGenerateContent')) { res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requests === 2) res.end('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
        else { res.write('data: {"candidates":[{"content":{"parts":[{"text":"PRIVATE OUTPUT"}]}}]}\n\n'); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
        const db = getAdminFirestore(initializeSandbox().withAuth(null));
        const input = { config, db, runId: crypto.randomUUID(), apiKey: 'PRIVATE KEY', credentials: async () => ({ idToken: 'PRIVATE TOKEN', appCheckToken: 'PRIVATE CHECK' }), loopbackFixture: `http://127.0.0.1:${address.port}` };
        const result = await runLiveCases(input);
        expect(result.cases.map(c => c.status)).toEqual(['complete', 'complete', 'complete', 'complete']);
        expect(requests).toBe(3);
        expect(result.finalBudget.dispatches).toBe(3);
        expect(result.finalBudget.active).toBe(1);
        expect(result.cases[2].dispatches).toBe(0);
        expect(result.cases[3].remoteState).toBe('unknown');
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
        await expect(runLiveCases(input)).rejects.toThrow();
        expect(requests).toBe(3);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

test('unknown calls exhaust shared capacity without a new case resetting it', async () => {
    let requests = 0;
    const server = createServer(async (req, res) => { for await (const _ of req) {} requests++; res.writeHead(503); res.end('PRIVATE ERROR'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
        const result = await runLiveCases({ config: { ...config, limits: { ...config.limits, maxConcurrent: 1 } },
            db: getAdminFirestore(initializeSandbox().withAuth(null)), runId: crypto.randomUUID(), apiKey: 'fixture', credentials: async () => ({ idToken: 'fixture', appCheckToken: 'fixture' }), loopbackFixture: `http://127.0.0.1:${address.port}` });
        expect(requests).toBe(1); expect(result.finalBudget.dispatches).toBe(1); expect(result.finalBudget.active).toBe(1);
        expect(result.cases.filter(c => c.status === 'complete').map(c => c.caseId)).toEqual(['abort-before-dispatch']);
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
