import { peer } from './process-peer.mjs';
import { scripted } from '../adapters/scripted.mjs';
let url; const active = new Map();
const api = peer(process, {
    init: async input => { url = input.url; return { ready: true }; },
    start: async ({ requestId = 'request-one', uid = 'alice', key = requestId, abortBefore = false, deadlineMs = null }) => {
        if (abortBefore) return { status: 'aborted-before-dispatch' };
        const reserved = await api.call('reserve', { requestId, uid }); if (!reserved.allowed) return reserved;
        const controller = new AbortController();
        const adapter = scripted({ url, emit: observation => api.call('observation', { requestId, observation }) });
        await api.call('dispatch', { requestId });
        const handle = await adapter.start({ key, signal: controller.signal });
        active.set(requestId, { ...handle, controller, uid, adapter });
        if (deadlineMs !== null) {
            const timer = setTimeout(() => controller.abort(), deadlineMs);
            handle.completion.finally(() => clearTimeout(timer));
        }
        return { status: 'started', providerOperationId: handle.providerOperationId };
    },
    stop: async ({ requestId = 'request-one', uid = 'alice' }) => {
        const handle = active.get(requestId); if (!handle || handle.uid !== uid) return { status: 'denied' };
        return handle.adapter.requestStop(handle.providerOperationId);
    },
    abort: async ({ requestId = 'request-one' }) => { active.get(requestId)?.controller.abort(); return { status: 'abort-requested' }; },
    observe: async ({ providerOperationId, requestId = 'request-one' }) => scripted({ url, emit: observation => api.call('observation', { requestId, observation }) }).observe(providerOperationId),
});
process.once('disconnect', () => process.exit(0));
process.send({ type: 'ready', processId: process.pid });
