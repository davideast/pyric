import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { peer } from './process-peer.mjs';
import { scripted } from '../adapters/scripted.mjs';
let url;
const active = new Map();
const instanceId = `gateway-${process.pid}`;
const context = requestId => ({ requestId, attemptId: randomUUID(), instanceId });
const server = createServer((req, res) => {
    const requestId = req.url?.replace('/output/', '');
    const handle = active.get(requestId);
    if (req.method !== 'GET' || !req.url?.startsWith('/output/') || !handle) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders();
    handle.outputs.add(res);
    res.once('close', () => {
        handle.outputs.delete(res);
        if (!handle.settled) {
            api.call('observation', { ...handle.context, observation: { status: 'client-disconnected', source: 'gateway-observation', strength: 'none' } })
                .finally(() => handle.controller.abort()).catch(() => {});
        }
    });
});
const api = peer(process, {
    init: async input => {
        url = input.url;
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback-address-unavailable');
        return { ready: true, clientUrl: `http://127.0.0.1:${address.port}` };
    },
    start: async ({ requestId = 'request-one', uid = 'alice', key = requestId, abortBefore = false, deadlineMs = null }) => {
        if (abortBefore) return { status: 'aborted-before-dispatch' };
        const invocation = context(requestId);
        const reserved = await api.call('reserve', { ...invocation, uid }); if (!reserved.allowed) return reserved;
        const controller = new AbortController();
        const adapter = scripted({ url, emit: async observation => {
            await api.call('observation', { ...invocation, observation });
            const current = active.get(requestId);
            if (current && observation.status === 'chunk') for (const output of current.outputs) output.write('{"chunk":true}\n');
        } });
        await api.call('dispatch', invocation);
        const handle = await adapter.start({ key, signal: controller.signal });
        const entry = { ...handle, controller, uid, adapter, context: invocation, outputs: new Set(), settled: false, outcome: 'pending' };
        active.set(requestId, entry);
        handle.completion.then(() => { entry.outcome = 'local-output-settled'; }, () => { entry.outcome = 'local-output-failed'; }).finally(() => {
            entry.settled = true;
            for (const output of entry.outputs) output.end();
        });
        if (deadlineMs !== null) {
            const timer = setTimeout(() => controller.abort(), deadlineMs);
            handle.completion.finally(() => clearTimeout(timer)).catch(() => {});
        }
        return { status: 'started', providerOperationId: handle.providerOperationId };
    },
    stop: async ({ requestId = 'request-one', uid = 'alice' }) => {
        const handle = active.get(requestId); if (!handle || handle.uid !== uid) return { status: 'denied' };
        return handle.adapter.requestStop(handle.providerOperationId);
    },
    abort: async ({ requestId = 'request-one' }) => { active.get(requestId)?.controller.abort(); return { status: 'abort-requested' }; },
    observe: async ({ providerOperationId, requestId = 'request-one' }) => {
        const invocation = context(requestId);
        return scripted({ url, emit: observation => api.call('observation', { ...invocation, observation }) }).observe(providerOperationId);
    },
    drain: async () => {
        const handles = [...active.values()];
        for (const handle of handles) if (!handle.settled) handle.controller.abort();
        await Promise.allSettled(handles.map(handle => handle.completion));
        return handles.map(handle => ({ ...handle.context, providerOperationId: handle.providerOperationId, outcome: handle.outcome }));
    },
});
process.once('disconnect', () => { server.closeAllConnections(); server.close(); process.exit(0); });
process.send({ type: 'ready', processId: process.pid });
