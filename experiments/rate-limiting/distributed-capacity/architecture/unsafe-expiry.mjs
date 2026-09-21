import { recordKey } from './capacity.mjs';
// Deliberately unsafe control: a timer is NOT evidence that a provider stopped.
export async function releaseOnExpiry(store, owner, now, request) {
    return store.transaction({ ...request, instanceId: owner, phase: 'unsafe-expiry' }, async tx => {
        const path = `requests/${recordKey(request.uid, request.requestId)}`;
        const record = await tx.get(path);
        if (!record || record.leaseUntil > now || ['completed', 'cancelled', 'expired'].includes(record.state)) throw new Error('not-expired');
        const global = await tx.get('capacity/global'), user = await tx.get(`users/${request.uid}`);
        tx.put('capacity/global', { active: global.active - 1 });
        tx.put(`users/${request.uid}`, { active: user.active - 1 });
        const next = { ...record, state: 'expired', owner, fence: record.fence + 1 };
        tx.put(path, next); return next;
    });
}
