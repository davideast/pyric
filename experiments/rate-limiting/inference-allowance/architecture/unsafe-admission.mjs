import { consume } from './bucket.mjs';
import { quotaPath, receiptPath } from './admission.mjs';
// Negative control. Intentionally separates read and write. Never deploy.
export async function unsafeAdmit(store, request, policies, clock) {
    const path = quotaPath(request.uid);
    const quota = await store.get(path);
    const result = consume(quota?.buckets?.[request.category], policies[request.category], clock.now());
    if (!result.allowed)
        return { status: 'quota_exhausted' };
    await store.put(path, { policyVersion: policies.version, buckets: { ...quota?.buckets, [request.category]: result.bucket } });
    await store.put(receiptPath(request.uid, request.requestId), { uid: request.uid, category: request.category, payloadHash: request.payloadHash, state: 'admitted' });
    return { status: 'admitted' };
}
