import { describe, it, expect, beforeEach } from 'bun:test';
import { admit } from '../../integrated-admission/architecture/admission.mjs';
import { markDispatching } from '../../integrated-admission/architecture/transitions.mjs';
import { claimExpired } from '../architecture/recovery-claim.mjs';
import { reconcile } from '../architecture/reconcile.mjs';
import { POLICIES, LIMITS, RECOVERY_BUDGET } from '../fixtures/contracts.mjs';

function makeFakeStore() {
    const docs = new Map();
    return {
        docs,
        async get(path) { return docs.get(path) ?? null; },
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

const request = (overrides = {}) => ({
    uid: 'alice', requestId: 'r1', category: 'chat', model: 'fake', payloadHash: 'ph1',
    ...overrides,
});

describe('reconcile() 8-row decision engine', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    async function setupClaimedDispatch(now = 12000) {
        const admitted = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        await markDispatching(store, request(), admitted.record.fence, { instanceId: 'gw-a' });
        const claimed = await claimExpired(store, request(), { owner: 'rec-1', now: () => now, leaseMs: 10000 }, { instanceId: 'rec-1' });
        return claimed.record;
    }

    it('refunds pre-dispatch reserved record and releases slot', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        const claimed = await claimExpired(store, request(), { owner: 'rec-1', now: () => 12000, leaseMs: 10000 }, { instanceId: 'rec-1' });
        const outcome = await reconcile(
            store, request(), claimed.record.fence, null,
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(outcome.action).toBe('refunded-pre-dispatch');
        expect(store.docs.get('capacity/global').active).toBe(0);
    });

    it('settles terminal completed evidence and decrements slot once', async () => {
        const claimed = await setupClaimedDispatch();
        const outcome = await reconcile(
            store, request(), claimed.fence, { state: 'completed' },
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(outcome.action).toBe('settled-terminal');
        expect(outcome.record.state).toBe('completed');
        expect(store.docs.get('capacity/global').active).toBe(0);
    });

    it('reschedules running job with backoff and retains slot', async () => {
        const claimed = await setupClaimedDispatch();
        const outcome = await reconcile(
            store, request(), claimed.fence, { state: 'running' },
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(outcome.action).toBe('rescheduled-running');
        expect(outcome.record.nextCheckAt).toBe(12000 + RECOVERY_BUDGET.backoffMs);
        expect(store.docs.get('capacity/global').active).toBe(1);
    });

    it('retains slot and records pendingCancel when stop is pending', async () => {
        const claimed = await setupClaimedDispatch();
        const outcome = await reconcile(
            store, request(), claimed.fence, { state: 'stop-pending' },
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(outcome.action).toBe('retained-pending-cancel');
        expect(outcome.record.pendingCancel).toBe(true);
        expect(store.docs.get('capacity/global').active).toBe(1);
    });

    it('retries transiently unavailable status within budget then quarantines on exhaustion', async () => {
        const claimed = await setupClaimedDispatch();
        const r1 = await reconcile(
            store, request(), claimed.fence, { state: 'unavailable' },
            { policies: POLICIES, limits: LIMITS, budget: { ...RECOVERY_BUDGET, maxReconcileAttempts: 2 }, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(r1.action).toBe('rescheduled-unavailable');

        const r2 = await reconcile(
            store, request(), claimed.fence, { state: 'unavailable' },
            { policies: POLICIES, limits: LIMITS, budget: { ...RECOVERY_BUDGET, maxReconcileAttempts: 2 }, now: () => 14000 },
            { instanceId: 'rec-1' },
        );
        expect(r2.action).toBe('quarantined');
        expect(r2.quarantineReason).toBe('retry-budget-exhausted');
        expect(store.docs.get('capacity/global').active).toBe(1);
    });

    it('quarantines absent/unobservable job after dispatch intent', async () => {
        const claimed = await setupClaimedDispatch();
        const outcome = await reconcile(
            store, request(), claimed.fence, { state: 'absent' },
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 12000 },
            { instanceId: 'rec-1' },
        );
        expect(outcome.action).toBe('quarantined');
        expect(outcome.quarantineReason).toBe('provider-unobservable');
        expect(store.docs.get('capacity/global').active).toBe(1);
    });

    it('rejects stale worker fence after takeover', async () => {
        const claimed1 = await setupClaimedDispatch(12000);
        await claimExpired(store, request(), { owner: 'rec-2', now: () => 25000, leaseMs: 10000 }, { instanceId: 'rec-2' });
        await expect(reconcile(
            store, request(), claimed1.fence, { state: 'running' },
            { policies: POLICIES, limits: LIMITS, budget: RECOVERY_BUDGET, now: () => 25000 },
            { instanceId: 'rec-1' },
        )).rejects.toMatchObject({ code: 'stale-owner' });
    });
});
