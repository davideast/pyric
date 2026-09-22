import { randomUUID } from 'node:crypto';
import { rpcMessage } from './rpc-message.mjs';

export function storeClient() {
    const pending   = new Map();
    const callbacks = new Map();

    const call = (method, args = {}) => new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        process.send({ type: 'rpc-call', id, method, args });
    });

    process.on('message', async raw => {
        const message = rpcMessage(raw);
        if (!message) return;

        if (message.type === 'rpc-reply') {
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            if (message.error) waiter.reject(Object.assign(new Error(message.error), { code: message.error }));
            else waiter.resolve(message.value);
            return;
        }

        if (message.type === 'transaction-callback') {
            const fn = callbacks.get(message.callId);
            const writes = [];
            try {
                const value = await fn({
                    get: path => call('read', { attempt: message.attempt, path }),
                    put: (path, data) => { writes.push([path, data]); },
                });
                await call('commit', { attempt: message.attempt, writes });
                process.send({ type: 'transaction-result', attempt: message.attempt, value });
            } catch (error) {
                process.send({ type: 'transaction-result', attempt: message.attempt, error: error.code ?? error.message });
            }
        }
    });

    const store = {
        get: path => call('get', { path }),
        listRequests: () => call('list-requests'),
        async transaction(context, fn) {
            const callId = randomUUID();
            callbacks.set(callId, fn);
            try { return await call('transaction', { callId, context }); }
            finally { callbacks.delete(callId); }
        },
    };

    return { store, call };
}
