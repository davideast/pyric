import { describe, expect, test } from 'bun:test';
import { createFairAllocationCluster } from '../adapters/pyric.mjs';

describe('bounded queue lifecycle (queue.mjs)', () => {
    test('enqueue() admits item without consuming execution capacity and is idempotent on identical payloadHash', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'queue-unit-1' });
        const req = { uid: 'alice', requestId: 'q-1', category: 'chat', model: 'fake', payloadHash: 'ph-1' };

        const first = await cluster.enqueue(req, 'gw-1');
        expect(first.status).toBe('queue-admitted');
        expect(first.record.enqueueSeq).toBe(1);

        const second = await cluster.enqueue(req, 'gw-2');
        expect(second.status).toBe('duplicate');
        expect(second.record.enqueueSeq).toBe(1);

        const snap = await cluster.snapshot();
        expect(snap.capacity).toHaveLength(0);
    });

    test('enqueue() throws payload_mismatch when same requestId is re-offered with a different payloadHash', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'queue-unit-2' });
        await cluster.enqueue({ uid: 'alice', requestId: 'q-2', category: 'chat', model: 'fake', payloadHash: 'ph-orig' });

        await expect(
            cluster.enqueue({ uid: 'alice', requestId: 'q-2', category: 'chat', model: 'fake', payloadHash: 'ph-changed' }),
        ).rejects.toThrow('payload_mismatch');
    });

    test('enqueue() enforces per-user pending limit (8) and global pending limit (24)', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'queue-unit-3' });
        for (let i = 0; i < 8; i++) {
            const r = await cluster.enqueue({ uid: 'alice', requestId: `qa-${i}`, payloadHash: `p-${i}` });
            expect(r.status).toBe('queue-admitted');
        }
        const ninth = await cluster.enqueue({ uid: 'alice', requestId: 'qa-8', payloadHash: 'p-8' });
        expect(ninth.status).toBe('queue-rejected');
        expect(ninth.reason).toBe('user-queue-full');
    });

    test('cancelQueued() and expireQueued() transition queued entries without dispatching them', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'queue-unit-4' });
        const reqCancel = { uid: 'alice', requestId: 'qc-1', payloadHash: 'pc-1' };
        const reqExpire = { uid: 'bob', requestId: 'qe-1', payloadHash: 'pe-1' };

        await cluster.enqueue(reqCancel);
        await cluster.enqueue(reqExpire);

        const c = await cluster.cancelQueued(reqCancel);
        expect(c.status).toBe('cancelled');

        cluster.advance(31_000);
        const e = await cluster.expireQueued(reqExpire);
        expect(e.status).toBe('expired');
    });
});
