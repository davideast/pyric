import { createHash } from 'node:crypto';
import { consume, COST } from '../../inference-allowance/architecture/bucket.mjs';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const quotaPath   = uid              => `quotas/${hash(uid)}`;
export const requestPath = (uid, requestId) => `requests/${hash([uid, requestId])}`;
export const providerKey = (uid, requestId) => hash([uid, requestId, 'provider']);
export { COST };

/**
 * Atomic combined admission: reads receipt, quota, and both capacity counters,
 * then either commits all four writes or none of them.
 *
 * All reads precede all writes (Firestore transaction contract).
 * Duplicate same-payload  → return saved state, no second debit.
 * Duplicate diff-payload  → conflict, no writes.
 * quota_exhausted or busy → no writes at all.
 *
 * @param {object} store - Instrumented Firestore adapter (store.mjs)
 * @param {{ uid, requestId, category, model, payloadHash }} request
 * @param {{ policies, limits, owner, now: () => number }} opts
 * @param {object} context - Transaction context for instrumented store
 * @returns {Promise<{ status: 'admitted'|'duplicate'|'conflict'|'quota_exhausted'|'busy', record?, retryAfterMs? }>}
 */
export async function admit(store, request, { policies, limits, owner, now }, context) {
    const rPath = requestPath(request.uid, request.requestId);
    return store.transaction(context, async tx => {
        // --- All reads first ---
        const existing = await tx.get(rPath);

        if (existing) {
            if (existing.payloadHash !== request.payloadHash) return { status: 'conflict' };
            return { status: 'duplicate', record: existing };
        }

        const qPath  = quotaPath(request.uid);
        const quota  = await tx.get(qPath);
        const global = await tx.get('capacity/global')              ?? { active: 0 };
        const user   = await tx.get(`users/${hash(request.uid)}`)   ?? { active: 0 };

        // --- Evaluate allowance ---
        const bucketResult = consume(
            quota?.buckets?.[request.category],
            policies[request.category],
            now(),
        );
        if (!bucketResult.allowed)
            return { status: 'quota_exhausted', retryAfterMs: bucketResult.retryAfterMs };

        // --- Evaluate capacity ---
        if (!Number.isSafeInteger(global.active) || !Number.isSafeInteger(user.active))
            throw Object.assign(new Error('invalid-counter'), { code: 'invalid-counter' });
        if (global.active >= limits.global || user.active >= limits.perUser)
            return { status: 'busy' };

        // --- All writes last ---
        const record = {
            uid:             request.uid,
            requestId:       request.requestId,
            category:        request.category,
            model:           request.model,
            payloadHash:     request.payloadHash,
            providerKey:     providerKey(request.uid, request.requestId),
            policyVersion:   policies.version,
            owner,
            fence:           1,
            leaseUntil:      now() + limits.leaseMs,
            state:           'reserved',
            debitState:      'debited',
            terminalEvidence: null,
        };

        tx.put(qPath, {
            policyVersion: policies.version,
            buckets: { ...quota?.buckets, [request.category]: bucketResult.bucket },
        });
        tx.put('capacity/global',          { active: global.active + 1 });
        tx.put(`users/${hash(request.uid)}`, { active: user.active  + 1 });
        tx.put(rPath, record);

        return { status: 'admitted', record };
    });
}
