import { describe, it, expect, beforeEach } from 'bun:test';
import { admit, requestPath } from '../../integrated-admission/architecture/admission.mjs';
import { claimExpired, renewHeartbeat } from '../architecture/recovery-claim.mjs';
import { POLICIES, LIMITS } from '../fixtures/contracts.mjs';

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

describe('claimExpired()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    it('rejects claim with lease-owned when lease is still active', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        const res = await claimExpired(store, request(), { owner: 'rec-1', now: () => 5000, leaseMs: 10000 }, { instanceId: 'rec-1' });
        expect(res.status).toBe('lease-owned');
        expect(res.record.fence).toBe(1);
    });

    it('claims expired reservation and increments fence', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        const res = await claimExpired(store, request(), { owner: 'rec-1', now: () => 12000, leaseMs: 10000 }, { instanceId: 'rec-1' });
        expect(res.status).toBe('claimed');
        expect(res.record.fence).toBe(2);
        expect(res.record.owner).toBe('rec-1');
        expect(res.record.leaseUntil).toBe(22000);
    });

    it('returns already-terminal when record is already completed', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        const reqPath = requestPath('alice', 'r1');
        store.docs.set(reqPath, { ...store.docs.get(reqPath), state: 'completed' });
        const res = await claimExpired(store, request(), { owner: 'rec-1', now: () => 12000, leaseMs: 10000 }, { instanceId: 'rec-1' });
        expect(res.status).toBe('already-terminal');
    });
});

describe('renewHeartbeat()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    it('extends leaseUntil when owner and fence match and lease is live', async () => {
        const admitted = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        const renewed = await renewHeartbeat(store, request(), admitted.record.fence, { owner: 'gw-a', now: () => 5000, leaseMs: 10000 }, { instanceId: 'gw-a' });
        expect(renewed.leaseUntil).toBe(15000);
    });

    it('rejects heartbeat with stale-owner after recovery takeover', async () => {
        const admitted = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: () => 1000 }, { instanceId: 'gw-a' });
        await claimExpired(store, request(), { owner: 'rec-1', now: () => 12000, leaseMs: 10000 }, { instanceId: 'rec-1' });
        await expect(renewHeartbeat(store, request(), admitted.record.fence, { owner: 'gw-a', now: () => 12500, leaseMs: 10000 }, { instanceId: 'gw-a' }))
            .rejects.toMatchObject({ code: 'stale-owner' });
    });
});
