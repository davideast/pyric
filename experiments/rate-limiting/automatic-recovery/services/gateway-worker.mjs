import { rpcMessage } from './rpc-message.mjs';
import { storeClient } from './store-client.mjs';
import { admit, providerKey } from '../../integrated-admission/architecture/admission.mjs';
import { markDispatching, refund, settle } from '../../integrated-admission/architecture/transitions.mjs';
import { renewHeartbeat } from '../architecture/recovery-claim.mjs';
import { unsafeReleaseOnExpiry } from '../architecture/unsafe-expiry.mjs';

const { store, call } = storeClient();
const owner = process.argv[2];

process.on('disconnect', () => process.exit(0));

process.on('message', async raw => {
    const message = rpcMessage(raw);
    if (!message || message.type !== 'command') return;

    const { id, operation, request, now: nowMs, policies, limits, fence, leaseMs } = message;
    const now = () => nowMs;
    const context = (phase = 'gateway') => ({
        requestId:  request?.requestId ?? null,
        instanceId: owner,
        uid:        request?.uid ?? null,
        phase,
    });

    try {
        let value;
        if (operation === 'admit') {
            value = await admit(store, request, { policies, limits, owner, now }, context('admission'));
        } else if (operation === 'dispatch') {
            value = await markDispatching(store, request, fence, context('dispatch'));
        } else if (operation === 'heartbeat') {
            value = await renewHeartbeat(store, request, fence, { owner, now, leaseMs: leaseMs ?? limits.leaseMs }, context('heartbeat'));
        } else if (operation === 'provider-start') {
            const pKey = request.providerKey ?? providerKey(request.uid, request.requestId);
            value = await call('provider-start', { key: pKey, uid: request.uid });
        } else if (operation === 'settle') {
            const pKey = request.providerKey ?? providerKey(request.uid, request.requestId);
            const evidence = await call('provider-observe', { key: pKey });
            value = await settle(store, request, fence, evidence, context('settle'));
        } else if (operation === 'refund') {
            value = await refund(store, request, fence, { policies, limits, now }, context('refund'));
        } else if (operation === 'unsafe-expire') {
            value = await unsafeReleaseOnExpiry(store, request, { now }, context('unsafe-expire'));
        } else {
            throw Object.assign(new Error('unsupported-command'), { code: 'unsupported-command' });
        }
        process.send({ type: 'command-result', id, value });
    } catch (error) {
        process.send({ type: 'command-result', id, error: error.code ?? error.message });
    }
});
