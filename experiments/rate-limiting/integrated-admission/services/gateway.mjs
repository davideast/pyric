import { createServer } from 'node:http';
import { admit, providerKey } from '../architecture/admission.mjs';
import { markDispatching, refund, settle, quarantine } from '../architecture/transitions.mjs';

/**
 * HTTP Gateway handler for integrated admission + accounting.
 * Never performs any provider HTTP call inside a Firestore transaction callback.
 *
 * @param {{ store, provider, policies, limits, owner, now: () => number }} deps
 */
export function createGatewayHandler({ store, provider, policies, limits, owner, now }) {
    const context = (request, phase = 'integrated-admission') => ({
        requestId:  request?.requestId ?? null,
        instanceId: owner,
        uid:        request?.uid ?? null,
        phase,
    });

    return {
        async handleInfer(request) {
            const admitted = await admit(store, request, { policies, limits, owner, now }, context(request));
            if (admitted.status !== 'admitted') return admitted;

            const dispatching = await markDispatching(store, request, admitted.record.fence, context(request, 'dispatch'));
            await provider.start(dispatching.providerKey, request.uid);
            await provider.finish(dispatching.providerKey, 'completed');
            const evidence = await provider.observe(dispatching.providerKey);

            if (['completed', 'cancelled'].includes(evidence.state)) {
                return settle(store, request, dispatching.fence, evidence, context(request, 'settle'));
            }
            return quarantine(store, request, dispatching.fence, context(request, 'quarantine'));
        },

        async handleCancel(request, fence) {
            return refund(store, request, fence, { policies, limits, now }, context(request, 'refund'));
        },

        async handleSettle(request, fence) {
            const pKey     = request.providerKey ?? providerKey(request.uid, request.requestId);
            const evidence = await provider.observe(pKey);
            return settle(store, request, fence, evidence, context(request, 'settle'));
        },
    };
}

/**
 * Create a Node HTTP server exposing POST /infer, POST /cancel, POST /settle.
 */
export function createGatewayServer(deps) {
    const handler = createGatewayHandler(deps);
    return createServer(async (req, res) => {
        try {
            let body = '';
            for await (const chunk of req) body += chunk;
            const payload = body ? JSON.parse(body) : {};
            let result;
            if (req.method === 'POST' && req.url === '/infer') {
                result = await handler.handleInfer(payload.request ?? payload);
            } else if (req.method === 'POST' && req.url === '/cancel') {
                result = await handler.handleCancel(payload.request, payload.fence);
            } else if (req.method === 'POST' && req.url === '/settle') {
                result = await handler.handleSettle(payload.request, payload.fence);
            } else {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'not-found' }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.code ?? error.message }));
        }
    });
}
