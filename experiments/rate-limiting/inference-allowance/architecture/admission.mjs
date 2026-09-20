import { createHash } from 'node:crypto';
import { consume } from './bucket.mjs';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const quotaPath = uid => `quotas/${hash(uid)}`;
export const receiptPath = (uid, requestId) => `admissions/${hash([uid, requestId])}`;
export async function admit(store, request, policies, clock, context) {
    const path = receiptPath(request.uid, request.requestId);
    return store.transaction(context, async (tx) => {
        const old = await tx.get(path);
        if (old) {
            if (old.payloadHash !== request.payloadHash)
                return { status: 'conflict' };
            return { status: 'duplicate', receipt: old };
        }
        const qpath = quotaPath(request.uid);
        const quota = await tx.get(qpath);
        if (quota && (quota.policyVersion !== policies.version || !quota.buckets || typeof quota.buckets !== 'object' || Array.isArray(quota.buckets) || Object.keys(quota.buckets).some(key => !['chat', 'agent'].includes(key))))
            throw new Error('invalid_quota');
        const result = consume(quota?.buckets?.[request.category], policies[request.category], clock.now());
        if (!result.allowed)
            return { status: 'quota_exhausted', retryAfterMs: result.retryAfterMs };
        const receipt = { uid: request.uid, category: request.category, payloadHash: request.payloadHash, state: 'admitted' };
        tx.put(qpath, { policyVersion: policies.version, buckets: { ...quota?.buckets, [request.category]: result.bucket } });
        tx.put(path, receipt);
        return { status: 'admitted', receipt };
    });
}
