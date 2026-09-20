import { releaseOnExpiry } from '../architecture/unsafe-expiry.mjs';
import { rpcMessage } from './rpc-message.mjs';
import { createCapacity } from '../architecture/capacity.mjs';
import { storeClient } from './store-client.mjs';
const { store, call } = storeClient();
const owner = process.argv[2];
process.on('disconnect', () => process.exit(0));
process.on('message', async raw => {
        const message = rpcMessage(raw); if (!message) return;
    if (message.type !== 'command') return;
    const capacity = createCapacity({ store, owner, now: () => message.now, limits: message.limits });
    const { operation, request } = message;
    const resume = async record => {
        const intent = await capacity.dispatch(request, record.fence);
        await call('provider-start', { key: intent.providerKey, uid: request.uid });
        const evidence = await call('provider-observe', { key: intent.providerKey });
        return { status: 'started', record: await capacity.observe(request, record.fence, evidence) };
    };
    try {
        let value;
        if (operation === 'reserve') value = await capacity.reserve(request);
        else if (operation === 'start') {
            const reserved = await capacity.reserve(request);
            value = reserved;
            if (reserved.status === 'reserved') value = await resume(reserved.record);
        } else if (operation === 'resume') value = await resume(await capacity.get(request));
        else if (operation === 'intent') value = await capacity.dispatch(request, message.fence);
        else if (operation === 'renew') value = await capacity.renew(request, message.fence);
        else if (operation === 'unsafe-expire') value = await releaseOnExpiry(store, owner, message.now, request);
        else if (operation === 'takeover') value = await capacity.takeover(request);
        else if (operation === 'reconcile') {
            const record = await capacity.get(request);
            const evidence = await call('provider-observe', { key: record.providerKey });
            value = await capacity.observe(request, record.fence, evidence);
        } else throw new Error('unsupported-command');
        process.send({ type: 'command-result', id: message.id, value });
    } catch (error) { process.send({ type: 'command-result', id: message.id, error: error.code ?? error.message }); }
});
process.send({ type: 'ready', owner, processId: process.pid, nodeVersion: process.version });
