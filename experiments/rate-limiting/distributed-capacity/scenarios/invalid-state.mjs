import { getFirestore } from 'pyric/sandbox/admin-firestore';
import { recordKey } from '../architecture/capacity.mjs';
export const limits = { global: 1, perUser: 1, leaseMs: 100 };
export const checks = ['invalid user rejected', 'corrupt counter rejected', 'malformed reservation rejected', 'client access denied', 'no inference from malformed state'];
export async function run({ cluster, provider, check }) {
    const a = await cluster.spawn('a');
    const errorOf = async operation => { try { await operation(); return 'allowed'; } catch (error) { return error.code ?? error.message; } };
    check('invalid user rejected', await errorOf(() => a.command('reserve', { uid: '../outside', requestId: 'bad' })), 'invalid-request');
    await cluster.store.put('capacity/global', { active: -1 });
    const request = { uid: 'alice', requestId: 'malformed' };
    check('corrupt counter rejected', await errorOf(() => a.command('reserve', request)), 'invalid-counter');
    await cluster.store.put('capacity/global', { active: 1 });
    await cluster.store.put('users/alice', { active: 1 });
    await cluster.store.put(`requests/${recordKey(request.uid, request.requestId)}`, { ...request, state: 'reserved', owner: 'previous', leaseUntil: 900, providerKey: recordKey(request.uid, request.requestId) });
    check('malformed reservation rejected', await errorOf(() => a.command('takeover', request)), 'invalid-reservation');
    const denied = await errorOf(() => getFirestore(cluster.sandbox.withAuth({ uid: 'alice' })).doc('capacityExperiments/protected').set({ active: 0 }));
    check('client access denied', String(denied).includes('permission-denied'), true);
    check('no inference from malformed state', provider.snapshot().jobs.length, 0);
    return { clientDenied: denied };
}
