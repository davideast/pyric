// Gateway worker child process.
// Each worker has a unique owner (process.argv[2]) and a logical clock
// advanced by the controller. The owner communicates with the parent's
// Pyric sandbox via IPC (store-client.mjs).

import { rpcMessage } from './rpc-message.mjs';
import { storeClient } from './store-client.mjs';
import { admit, providerKey, hash } from '../architecture/admission.mjs';
import { markDispatching, refund, settle, quarantine } from '../architecture/transitions.mjs';

const { store, call } = storeClient();
const owner = process.argv[2];

process.on('disconnect', () => process.exit(0));

process.on('message', async raw => {
    const message = rpcMessage(raw);
    if (!message || message.type !== 'command') return;

    const { id, operation, request, now: nowMs, policies, limits, fence } = message;
    const now = () => nowMs;

    const context = extra => ({
        requestId:  request?.requestId ?? null,
        instanceId: owner,
        uid:        request?.uid ?? null,
        phase:      'integrated-admission',
        ...extra,
    });

    try {
        let value;

        if (operation === 'admit') {
            value = await admit(store, request, { policies, limits, owner, now }, context());
        } else if (operation === 'dispatch') {
            value = await markDispatching(store, request, fence, context({ phase: 'dispatch' }));
        } else if (operation === 'start') {
            // Full happy-path: admit → dispatch intent → provider start → provider finish → settle
            const admitted = await admit(store, request, { policies, limits, owner, now }, context());
            value = admitted;
            if (admitted.status === 'admitted') {
                const dispatching = await markDispatching(store, request, admitted.record.fence, context({ phase: 'dispatch' }));
                await call('provider-start', { key: dispatching.providerKey, uid: request.uid });
                await call('provider-finish', { key: dispatching.providerKey, state: 'completed' });
                const evidence = await call('provider-observe', { key: dispatching.providerKey });
                if (['completed', 'cancelled'].includes(evidence.state)) {
                    value = await settle(store, request, dispatching.fence, evidence, context({ phase: 'settle' }));
                } else {
                    value = await quarantine(store, request, dispatching.fence, context({ phase: 'quarantine' }));
                }
            }
        } else if (operation === 'refund') {
            value = await refund(store, request, fence, { policies, limits, now }, context({ phase: 'refund' }));
        } else if (operation === 'settle') {
            const pKey = request.providerKey ?? providerKey(request.uid, request.requestId);
            const evidence = await call('provider-observe', { key: pKey });
            value = await settle(store, request, fence, evidence, context({ phase: 'settle' }));
        } else if (operation === 'quarantine') {
            value = await quarantine(store, request, fence, context({ phase: 'quarantine' }));
        } else if (operation === 'get') {
            value = await store.get(`requests/${hash([request.uid, request.requestId])}`);
        } else {
            throw Object.assign(new Error('unsupported-command'), { code: 'unsupported-command' });
        }

        process.send({ type: 'command-result', id, value });
    } catch (error) {
        process.send({ type: 'command-result', id, error: error.code ?? error.message });
    }
});

process.send({ type: 'ready', owner, processId: process.pid, nodeVersion: process.version });
