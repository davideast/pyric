import { describe, it, expect, beforeEach } from 'bun:test';
import { admit, quotaPath, requestPath, COST } from '../architecture/admission.mjs';
import { POLICIES, LIMITS }                    from '../fixtures/policy.mjs';

// ── Minimal fake store ─────────────────────────────────────────────────────
function makeFakeStore() {
    const docs = new Map();
    return {
        docs,
        async get(path)           { return docs.get(path) ?? null; },
        async transaction(_ctx, callback) {
            const writes = [];
            const tx = {
                async get(path)        { return docs.get(path) ?? null; },
                put(path, data)        { writes.push([path, data]); },
            };
            const result = await callback(tx);
            for (const [path, data] of writes) docs.set(path, data);
            return result;
        },
    };
}

function nowMs() { return 1000; }
function ctx(instanceId = 'gw-a') { return { instanceId }; }

describe('admit()', () => {
    let store;
    beforeEach(() => { store = makeFakeStore(); });

    const request = (overrides = {}) => ({
        uid: 'alice', requestId: 'r1', category: 'chat', model: 'fake', payloadHash: 'ph1',
        ...overrides,
    });

    it('admits a fresh request and writes all four documents', async () => {
        const result = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        expect(result.status).toBe('admitted');
        expect(result.record.state).toBe('reserved');
        expect(result.record.debitState).toBe('debited');
        // All four documents must be written
        expect(store.docs.size).toBe(4);  // quota, capacity/global, users/..., requests/...
    });

    it('returns duplicate with no second write when same payload submitted twice', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        const docsAfterFirst = store.docs.size;
        const second = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        expect(second.status).toBe('duplicate');
        expect(store.docs.size).toBe(docsAfterFirst);   // no new writes
    });

    it('returns conflict when payload hash differs', async () => {
        await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        const conflict = await admit(
            store, request({ payloadHash: 'different' }),
            { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx(),
        );
        expect(conflict.status).toBe('conflict');
    });

    it('returns quota_exhausted when bucket is empty and writes nothing', async () => {
        // Pre-fill with an empty bucket
        const qPath = quotaPath('alice');
        store.docs.set(qPath, {
            policyVersion: POLICIES.version,
            buckets: { chat: { remaining: 0, updatedAt: 1000 } },
        });
        const docsBefore = store.docs.size;
        const result = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        expect(result.status).toBe('quota_exhausted');
        expect(store.docs.size).toBe(docsBefore);   // no writes
    });

    it('returns busy when global capacity is full and writes nothing', async () => {
        store.docs.set('capacity/global', { active: LIMITS.global });
        const docsBefore = store.docs.size;
        const result = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        expect(result.status).toBe('busy');
        expect(store.docs.size).toBe(docsBefore);
    });

    it('returns busy when per-user capacity is full and writes nothing', async () => {
        store.docs.set(`users/${(await import('../architecture/admission.mjs')).hash('alice')}`, { active: LIMITS.perUser });
        const docsBefore = store.docs.size;
        const result = await admit(store, request(), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        expect(result.status).toBe('busy');
        expect(store.docs.size).toBe(docsBefore);
    });

    it('uses independent buckets for chat and agent categories', async () => {
        await admit(store, request({ category: 'chat',  requestId: 'r-chat' }),  { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        await admit(store, request({ category: 'agent', requestId: 'r-agent' }), { policies: POLICIES, limits: LIMITS, owner: 'gw-a', now: nowMs }, ctx());
        const qPath = quotaPath('alice');
        const quotaDoc = store.docs.get(qPath);
        expect(quotaDoc.buckets.chat).toBeDefined();
        expect(quotaDoc.buckets.agent).toBeDefined();
        expect(quotaDoc.buckets.chat.remaining).not.toEqual(quotaDoc.buckets.agent.remaining);
    });
});
