import { rpcMessage } from './rpc-message.mjs';
import { randomUUID } from 'node:crypto';
// Native transaction callbacks run in the gateway process. The parent owns the
// in-process Pyric SDK and reruns this callback when its transaction retries.
export function storeClient() {
    const pending = new Map(), callbacks = new Map();
    function call(method, args) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject }); process.send({ type: 'rpc', id, method, args });
        });
    }
    process.on('message', async raw => {
        const message = rpcMessage(raw); if (!message) return;
        if (message.type === 'reply') {
            const waiter = pending.get(message.id); if (!waiter) return;
            pending.delete(message.id);
            if (message.error) waiter.reject(Object.assign(new Error(message.error), { code: message.error }));
            else waiter.resolve(message.value);
        } else if (message.type === 'transaction-callback') {
            const writes = [];
            try {
                const result = await callbacks.get(message.key)({
                    get: path => call('read', { attempt: message.attempt, path }),
                    put: (path, data) => writes.push({ path, data }),
                });
                await call('commit', { attempt: message.attempt, result, writes });
            } catch (error) { await call('commit', { attempt: message.attempt, error: error.code ?? error.message }); }
        }
    });
    return { call, store: {
        get: path => call('get', { path }),
        async transaction(context, callback) {
            const key = randomUUID(); callbacks.set(key, callback);
            try { return await call('transaction', { key, context }); } finally { callbacks.delete(key); }
        },
    } };
}
