import { describe, it, expect, beforeEach } from 'bun:test';
import { admit, requestPath, hash, COST }   from '../architecture/admission.mjs';
import { markDispatching, refund, settle, quarantine } from '../architecture/transitions.mjs';
import { POLICIES, LIMITS }                from '../fixtures/policy.mjs';

function makeFakeStore() {
    const docs = new Map();
    return {
        docs,
        async get(path)           { return docs.get(path) ?? null; },
        async transaction(_ctx, callback) {
            const writes = [];
            const tx = {
                async get(path) { return docs.get(path) ?? null; },
                put(path, data) { writes.push([path, data]); },
            };
            const result = await callback(tx);
            for (const [path, data] of writes) docs.set(path, data);
            return result;
        },
    };
}

const NOW       = 1000;
const nowFn     = () => NOW;
const ctx       = (instanceId = 'gw-a') => ({ instanceId });
const request   = (overrides = {}) => ({ uid: 'alice', requestId: 'r1', category: 'chat', model: 'fake', payloadHash: 'ph1', ...overrides });

async function admitOne(store) {
    return admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowFn }, ctx());
}

describe('markDispatching()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    it('transitions reserved → dispatching', async () => {
        const admitted = await admitOne(store);
        const dispatching = await markDispatching(store, request(), admitted.record.fence, ctx());
        expect(dispatching.state).toBe('dispatching');
    });

    it('throws stale-owner when fence does not match', async () => {
        await admitOne(store);
        await expect(markDispatching(store, request(), 999, ctx())).rejects.toMatchObject({ code: 'stale-owner' });
    });

    it('throws already-dispatching if called twice', async () => {
        const admitted = await admitOne(store);
        await markDispatching(store, request(), admitted.record.fence, ctx());
        await expect(markDispatching(store, request(), admitted.record.fence, ctx())).rejects.toMatchObject({ code: 'already-dispatching' });
    });
});

describe('refund()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    it('returns refunded and credits allowance when state is reserved', async () => {
        const admitted = await admitOne(store);
        const result   = await refund(store, request(), admitted.record.fence, { policies: POLICIES, limits: LIMITS, now: nowFn }, ctx());
        expect(result.status).toBe('refunded');
        expect(result.creditedUnits).toBeGreaterThan(0);
        expect(result.saturationLoss).toBeGreaterThanOrEqual(0);
    });

    it('releases the capacity counter', async () => {
        const admitted = await admitOne(store);
        await refund(store, request(), admitted.record.fence, { policies: POLICIES, limits: LIMITS, now: nowFn }, ctx());
        const globalDoc = store.docs.get('capacity/global');
        expect(globalDoc.active).toBe(0);
    });

    it('throws stale-owner for wrong fence', async () => {
        await admitOne(store);
        await expect(refund(store, request(), 999, { policies: POLICIES, limits: LIMITS, now: nowFn }, ctx()))
            .rejects.toMatchObject({ code: 'stale-owner' });
    });

    it('throws not-refundable after dispatching', async () => {
        const admitted = await admitOne(store);
        await markDispatching(store, request(), admitted.record.fence, ctx());
        await expect(refund(store, request(), admitted.record.fence, { policies: POLICIES, limits: LIMITS, now: nowFn }, ctx()))
            .rejects.toMatchObject({ code: 'not-refundable' });
    });

    it('records saturation loss when bucket is near-full at refund time', async () => {
        // Simulate: bucket was nearly full when debit happened, now it's still near-full
        const admitted = await admitOne(store);
        // Manually set quota bucket to nearly-full
        const qDoc = store.docs.get(`quotas/${hash('alice')}`);
        store.docs.set(`quotas/${hash('alice')}`, {
            ...qDoc,
            buckets: { chat: { remaining: 4 * COST + COST - 1, updatedAt: NOW } },  // one unit shy of full
        });
        const result = await refund(store, request(), admitted.record.fence, { policies: POLICIES, limits: LIMITS, now: nowFn }, ctx());
        expect(result.saturationLoss).toBeGreaterThan(0);
        expect(result.creditedUnits + result.saturationLoss).toBe(COST);
    });
});

describe('settle()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    async function getToDispatch() {
        const admitted    = await admitOne(store);
        const dispatching = await markDispatching(store, request(), admitted.record.fence, ctx());
        return dispatching;
    }

    it('transitions dispatching → completed and decrements counter', async () => {
        const dispatching = await getToDispatch();
        const settled = await settle(store, request(), dispatching.fence, { state: 'completed' }, ctx());
        expect(settled.state).toBe('completed');
        expect(store.docs.get('capacity/global').active).toBe(0);
    });

    it('is idempotent: second settle does not double-decrement', async () => {
        const dispatching = await getToDispatch();
        await settle(store, request(), dispatching.fence, { state: 'completed' }, ctx());
        // Counter is 0; a second settle should just return the record
        const second = await settle(store, request(), dispatching.fence, { state: 'completed' }, ctx());
        expect(second.state).toBe('completed');
        expect(store.docs.get('capacity/global').active).toBe(0);
    });

    it('throws for non-terminal evidence', async () => {
        const dispatching = await getToDispatch();
        await expect(settle(store, request(), dispatching.fence, { state: 'running' }, ctx()))
            .rejects.toMatchObject({ code: 'non-terminal-evidence' });
    });
});

describe('quarantine()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    it('sets state to unknown and retains counters', async () => {
        const admitted    = await admitOne(store);
        const dispatching = await markDispatching(store, request(), admitted.record.fence, ctx());
        await quarantine(store, request(), dispatching.fence, ctx());
        const rec = store.docs.get(requestPath('alice', 'r1'));
        expect(rec.state).toBe('unknown');
        // Counter is retained (not decremented)
        expect(store.docs.get('capacity/global').active).toBe(1);
    });
});
