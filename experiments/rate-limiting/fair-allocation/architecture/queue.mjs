import { hash } from '../../integrated-admission/architecture/admission.mjs';

const failure = code => Object.assign(new Error(code), { code });

export const queuePath = (uid, requestId) => `queue/${hash(`${uid}:${requestId}`)}`;
export const queueUserPath = uid => `queueMeta/user-${hash(uid)}`;
export const queueGlobalPath = 'queueMeta/global';

/**
 * Enqueue a request into the durable bounded queue without consuming execution
 * capacity or allowance. Enforces both global and per-user pending queue limits
 * and payload-bound idempotency inside a single transaction.
 */
export async function enqueue(store, request, { queueLimits, now }, context) {
    const qPath = queuePath(request.uid, request.requestId);
    const uPath = queueUserPath(request.uid);

    return store.transaction(context, async tx => {
        const existing = await tx.get(qPath);
        if (existing) {
            if (existing.payloadHash !== request.payloadHash) {
                throw failure('payload_mismatch');
            }
            return { status: 'duplicate', record: existing };
        }

        const globalMeta = (await tx.get(queueGlobalPath)) ?? { pending: 0, seq: 0 };
        const userMeta = (await tx.get(uPath)) ?? { pending: 0 };

        if (globalMeta.pending >= queueLimits.global) {
            return { status: 'queue-rejected', reason: 'global-queue-full', record: null };
        }
        if (userMeta.pending >= queueLimits.perUser) {
            return { status: 'queue-rejected', reason: 'user-queue-full', record: null };
        }

        const seq = (globalMeta.seq ?? 0) + 1;
        const ts = now();
        const record = {
            uid:         request.uid,
            requestId:   request.requestId,
            category:    request.category ?? 'chat',
            model:       request.model ?? 'fake',
            payloadHash: request.payloadHash,
            durationMs:  request.durationMs ?? 200,
            enqueueSeq:  seq,
            enqueuedAt:  ts,
            expiresAt:   ts + queueLimits.ttlMs,
            state:       'queued',
        };

        tx.put(queueGlobalPath, { pending: globalMeta.pending + 1, seq });
        tx.put(uPath, { pending: userMeta.pending + 1 });
        tx.put(qPath, record);
        return { status: 'queue-admitted', record };
    });
}

/**
 * Cancel a queued request if it has not yet been selected for dispatch.
 */
export async function cancelQueued(store, request, context) {
    const qPath = queuePath(request.uid, request.requestId);
    const uPath = queueUserPath(request.uid);

    return store.transaction(context, async tx => {
        const record = await tx.get(qPath);
        if (!record) throw failure('missing-queue-entry');
        if (record.state !== 'queued') {
            return { status: 'already-dispatched', record };
        }

        const globalMeta = (await tx.get(queueGlobalPath)) ?? { pending: 1, seq: 1 };
        const userMeta = (await tx.get(uPath)) ?? { pending: 1 };

        const updated = { ...record, state: 'cancelled' };
        tx.put(queueGlobalPath, { ...globalMeta, pending: Math.max(0, globalMeta.pending - 1) });
        tx.put(uPath, { pending: Math.max(0, userMeta.pending - 1) });
        tx.put(qPath, updated);
        return { status: 'cancelled', record: updated };
    });
}

/**
 * Expire a queued request whose TTL has elapsed before selection.
 */
export async function expireQueued(store, request, { now }, context) {
    const qPath = queuePath(request.uid, request.requestId);
    const uPath = queueUserPath(request.uid);

    return store.transaction(context, async tx => {
        const record = await tx.get(qPath);
        if (!record || record.state !== 'queued') {
            return { status: 'not-queued', record: record ?? null };
        }
        if (record.expiresAt > now()) {
            return { status: 'still-valid', record };
        }

        const globalMeta = (await tx.get(queueGlobalPath)) ?? { pending: 1, seq: 1 };
        const userMeta = (await tx.get(uPath)) ?? { pending: 1 };

        const updated = { ...record, state: 'expired' };
        tx.put(queueGlobalPath, { ...globalMeta, pending: Math.max(0, globalMeta.pending - 1) });
        tx.put(uPath, { pending: Math.max(0, userMeta.pending - 1) });
        tx.put(qPath, updated);
        return { status: 'expired', record: updated };
    });
}
