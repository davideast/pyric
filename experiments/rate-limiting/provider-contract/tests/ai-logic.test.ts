import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { aiLogicContract } from '../adapters/ai-logic.mjs';

test('the prepared AI Logic HTTP adapter makes one bounded request and never treats truncated output as terminal', async () => {
    const seen: any[] = []; const observations: any[] = []; let budget = 0;
    const server = createServer(async (req, res) => {
        const chunks = []; for await (const b of req) chunks.push(b);
        seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"candidates":[{"content":{"parts":[{"text":"PRIVATE GENERATED TEXT"}]}}]}\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
        const adapter = aiLogicContract({ projectId: 'fixture-project', model: 'fixture-model', appId: 'fixture-app', apiKey: 'fixture-key',
            loopbackFixture: `http://127.0.0.1:${address.port}`, credentials: async () => ({ idToken: 'fixture-auth', appCheckToken: 'fixture-check' }),
            reserveDispatch: async () => ++budget <= 1, emit: o => observations.push(o), maxOutputTokens: 64, timeoutMs: 1000 });
        const handle = await adapter.start({ prompt: 'synthetic', streaming: true }); await handle.completion;
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('/v1beta/projects/fixture-project/models/fixture-model:streamGenerateContent?alt=sse');
        expect(seen[0].body.generationConfig.maxOutputTokens).toBe(64);
        expect(observations.at(-1).status).toBe('unknown');
        expect(JSON.stringify(observations)).not.toContain('PRIVATE GENERATED TEXT');
        expect((await adapter.observe(null)).status).toBe('unsupported');
        expect((await adapter.requestStop(null)).status).toBe('unsupported');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('completion evidence requires a known terminal marker and survives split SSE delimiters', async () => {
    let mode = 'split'; let requests = 0; let charges = 0;
    const server = createServer((_req, res) => {
        requests++;
        if (mode === 'error') { res.writeHead(503); res.end('PRIVATE ERROR'); return; }
        if (mode === 'json') { res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 4 } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'unknown') { res.end('data: {"candidates":[{"finishReason":"UNRECOGNIZED"}]}\n\n'); return; }
        res.write('data: {"candidates":[{"finishReason":"STOP"}]}\r');
        setTimeout(() => { res.write('\n\r'); setTimeout(() => res.end('\n'), 10); }, 10);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
        const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
        const observations: any[] = [];
        const adapter = aiLogicContract({ projectId: 'fixture-project', model: 'fixture-model', appId: 'fixture', apiKey: 'fixture', loopbackFixture: `http://127.0.0.1:${address.port}`,
            credentials: async () => ({ idToken: 'SECRET', appCheckToken: 'SECRET' }), reserveDispatch: async () => ++charges <= 4, emit: o => observations.push(o), timeoutMs: 1000 });
        for (const value of ['split', 'json', 'unknown', 'error']) {
            mode = value;
            await (await adapter.start({ prompt: 'PRIVATE PROMPT', streaming: value !== 'json' })).completion;
            expect(observations.at(-1).status).toBe(['split', 'json'].includes(value) ? 'completed' : 'unknown');
        }
        const aborted = new AbortController(); aborted.abort();
        await (await adapter.start({ prompt: 'PRIVATE PROMPT', signal: aborted.signal })).completion;
        expect(charges).toBe(4); expect(requests).toBe(4);
        await expect(adapter.start({ prompt: 'PRIVATE PROMPT' })).rejects.toThrow('dispatch-budget-exhausted');
        expect(requests).toBe(4);
        expect(JSON.stringify(observations)).not.toMatch(/PRIVATE|SECRET/);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
