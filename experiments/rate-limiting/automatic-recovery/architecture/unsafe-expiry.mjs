import { requestPath, hash } from '../../integrated-admission/architecture/admission.mjs';

/**
 * UNSAFE NEGATIVE CONTROL: Releases execution capacity when a lease expires
 * without verifying that remote provider inference actually stopped.
 * Never deploy this variant to Cloud Run.
 */
export async function unsafeReleaseOnExpiry(store, request, { now }, context) {
    const reqPath = requestPath(request.uid, request.requestId);
    return store.transaction(context, async tx => {
        const record     = await tx.get(reqPath);
        const globalSlot = await tx.get('capacity/global');
        const userSlot   = await tx.get(`users/${hash(request.uid)}`);
        if (!record || record.leaseUntil > now()) return { released: false };
        if (['completed', 'cancelled', 'refunded', 'expired-released'].includes(record.state))
            return { released: false };

        tx.put('capacity/global', { active: Math.max(0, (globalSlot?.active ?? 0) - 1) });
        tx.put(`users/${hash(request.uid)}`, { active: Math.max(0, (userSlot?.active ?? 0) - 1) });
        const updated = { ...record, state: 'expired-released' };
        tx.put(reqPath, updated);
        return { released: true, record: updated };
    });
}
