import { createHash } from 'node:crypto';
export const recordKey = (uid, requestId) => createHash('sha256').update(JSON.stringify([uid, requestId])).digest('hex');
const terminal = record => ['completed', 'cancelled'].includes(record.state);
const failure = code => Object.assign(new Error(code), { code });

// Trusted gateway policy, using only the native-transaction store contract.
// Fences guard database transitions; they cannot fence a remote AI provider.
export function createCapacity({ store, owner, now, limits }) {
    const context = request => ({ ...request, instanceId: owner, phase: 'execution-capacity' });
    function validate(request) {
        if (!/^[a-z0-9-]{1,80}$/.test(request.uid ?? '') || !/^[a-z0-9-]{1,100}$/.test(request.requestId ?? '')) throw failure('invalid-request');
        if (![limits.global, limits.perUser, limits.leaseMs].every(value => Number.isSafeInteger(value) && value > 0)) throw failure('invalid-limits');
    }
    function current(record, fence) {
        if (!record || record.owner !== owner || record.fence !== fence) throw failure('stale-owner');
        if (record.leaseUntil <= now()) throw failure('lease-expired');
    }
    function validateRecord(record, request) {
        if (!record) return record;
        const states = ['reserved', 'dispatching', 'running', 'unknown', 'completed', 'cancelled'];
        if (record.uid !== request.uid || record.requestId !== request.requestId || record.providerKey !== recordKey(request.uid, request.requestId)
            || !states.includes(record.state) || typeof record.owner !== 'string' || !record.owner
            || !Number.isSafeInteger(record.fence) || record.fence < 1 || !Number.isSafeInteger(record.leaseUntil)) throw failure('invalid-reservation');
        return record;
    }
    const read = async (tx, request) => validateRecord(await tx.get(ref(request)), request);
    const ref = request => `requests/${recordKey(request.uid, request.requestId)}`;
    return {
        async reserve(request) {
            validate(request);
            return store.transaction(context(request), async tx => {
                const previous = await read(tx, request);
                if (previous) return { status: 'duplicate', record: previous };
                const global = await tx.get('capacity/global') ?? { active: 0 };
                const user = await tx.get(`users/${request.uid}`) ?? { active: 0 };
                if (![global.active, user.active].every(value => Number.isSafeInteger(value) && value >= 0)) throw failure('invalid-counter');
                if (global.active >= limits.global || user.active >= limits.perUser) return { status: 'busy' };
                const record = { ...request, owner, fence: 1, leaseUntil: now() + limits.leaseMs, state: 'reserved', providerKey: recordKey(request.uid, request.requestId) };
                tx.put('capacity/global', { active: global.active + 1 });
                tx.put(`users/${request.uid}`, { active: user.active + 1 });
                tx.put(ref(request), record);
                return { status: 'reserved', record };
            });
        },
        async dispatch(request, fence) {
            validate(request);
            return store.transaction(context(request), async tx => {
                const record = await read(tx, request); current(record, fence);
                if (record.state !== 'reserved') throw failure('already-dispatched');
                const next = { ...record, state: 'dispatching' };
                tx.put(ref(request), next); return next;
            });
        },
        async renew(request, fence) {
            validate(request);
            return store.transaction(context(request), async tx => {
                const record = await read(tx, request); current(record, fence);
                if (terminal(record)) throw failure('terminal-reservation');
                const next = { ...record, leaseUntil: now() + limits.leaseMs };
                tx.put(ref(request), next); return next;
            });
        },
        async takeover(request) {
            validate(request);
            return store.transaction(context(request), async tx => {
                const record = await read(tx, request);
                if (!record) throw failure('missing-reservation');
                if (terminal(record)) return record;
                if (record.leaseUntil > now()) throw failure('lease-owned');
                const next = { ...record, owner, fence: record.fence + 1, leaseUntil: now() + limits.leaseMs };
                if (record.state !== 'reserved') next.state = 'unknown';
                tx.put(ref(request), next); return next;
            });
        },
        async observe(request, fence, evidence) {
            validate(request);
            return store.transaction(context(request), async tx => {
                const record = await read(tx, request);
                if (record && terminal(record)) return record;
                current(record, fence);
                if (record.state === 'reserved') throw failure('not-dispatched');
                if (evidence.key !== record.providerKey) throw failure('wrong-provider-operation');
                if (!['completed', 'cancelled'].includes(evidence.state)) {
                    const state = evidence.state === 'running' ? 'running' : 'unknown';
                    const next = { ...record, state }; tx.put(ref(request), next); return next;
                }
                const global = await tx.get('capacity/global'), user = await tx.get(`users/${request.uid}`);
                if (![global?.active, user?.active].every(value => Number.isSafeInteger(value) && value > 0)) throw failure('invalid-counter');
                tx.put('capacity/global', { active: global.active - 1 });
                tx.put(`users/${request.uid}`, { active: user.active - 1 });
                const next = { ...record, state: evidence.state, terminalEvidence: 'fixture-provider-confirmation' };
                tx.put(ref(request), next); return next;
            });
        },
        async get(request) { validate(request); return validateRecord(await store.get(ref(request)), request); },
    };
}
