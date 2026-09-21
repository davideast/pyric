import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { peer } from './process-peer.mjs';
const jobs = new Map(); let profile = 'observable'; let attempts = 0; let stops = 0; let sequence = 0;
const history = []; const record = (kind, data = {}) => history.push({ kind, ...data, localSequence: ++sequence, localElapsedMs: performance.now() });
const observable = () => ['observable', 'missing', 'inaccessible'].includes(profile);
const packet = (job, status, source = 'provider-response') => ({ status, providerOperationId: observable() ? job.id : null,
    source, strength: ['completed', 'cancelled'].includes(status) ? 'authoritative-terminal' : 'informational',
    scope: 'one-provider-operation', observedAt: new Date().toISOString(), usage: status === 'completed' ? { totalTokenCount: 3 } : null });
const reply = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
    try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const [route, id] = req.url.slice(1).split('/');
        if (route === 'start' && req.method === 'POST') {
            attempts++; record('provider-dispatch-attempt');
            let job = observable() && [...jobs.values()].find(j => j.key === input.key);
            if (!job) { job = { id: randomUUID(), key: input.key, state: 'running', outputs: [], chunks: 0 }; jobs.set(job.id, job); record('provider-work-started', { id: job.id }); }
            reply(res, { ticket: job.id, providerOperationId: observable() ? job.id : null });
        } else if (route === 'output' && jobs.has(id)) {
            const job = jobs.get(id); res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders();
            job.outputs.push(res); record('output-subscribed', { id });
            res.once('close', () => { record('output-closed', { id }); });
        } else if (route === 'stop') {
            if (!observable()) return reply(res, { status: 'unsupported', source: 'provider-response', strength: 'none' });
            stops++; record('stop-acknowledged', { id }); reply(res, { status: 'acknowledged', providerOperationId: id, source: 'provider-response', strength: 'informational' });
        } else if (route === 'observe') {
            if (!observable()) return reply(res, { status: 'unsupported', source: 'provider-status-query', strength: 'none' });
            if (profile === 'missing' || profile === 'inaccessible') return reply(res, { status: 'unknown', source: 'provider-status-query', strength: 'none', reason: profile });
            const job = jobs.get(id);
            reply(res, job ? packet(job, job.state, 'provider-status-query') : { status: 'unknown', source: 'provider-status-query', strength: 'none' });
        } else reply(res, { status: 'unsupported' }, 404);
    } catch { reply(res, { status: 'unknown' }, 500); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('loopback-address-unavailable');
peer(process, {
    configure: async input => { profile = input.profile; return { url: `http://127.0.0.1:${address.port}` }; },
    control: async ({ operation, id, state }) => {
        const selected = id ? [jobs.get(id)] : [...jobs.values()];
        for (const job of selected.filter(Boolean)) {
            if (operation === 'chunk') { job.chunks++; for (const out of job.outputs) if (!out.destroyed) out.write(JSON.stringify({ status: 'chunk', bytes: 1 }) + '\n'); record('chunk-written', { id: job.id }); }
            else if (operation === 'drop') { for (const out of job.outputs) out.destroy(); record('transport-dropped', { id: job.id }); }
            else if (operation === 'terminal') {
                if (job.state === 'running') { job.state = state; record('provider-terminal', { id: job.id, state }); }
                for (const out of job.outputs) if (!out.destroyed) out.end(JSON.stringify(packet(job, job.state)) + '\n');
            }
        }
        return { applied: true };
    },
    snapshot: async () => ({ running: [...jobs.values()].filter(j => j.state === 'running').length, attempts, stops,
        jobs: [...jobs.values()].map(({ id, state, chunks }) => ({ id, state, chunks })), history }),
});
process.once('disconnect', () => { server.closeAllConnections(); server.close(); process.exit(0); });
process.send({ type: 'ready', processId: process.pid });
