import { describe, expect, test } from 'bun:test';
import { createFairAllocationCluster } from '../adapters/pyric.mjs';

describe('FIFO vs Round-Robin selectors (fifo.mjs & round-robin.mjs)', () => {
    test('selectNextFifo() selects strictly by enqueueSeq while respecting per-user cap (2)', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'sel-fifo-1' });
        // Alice enqueues 3 items first, Bob enqueues 1 item fourth
        await cluster.enqueue({ uid: 'alice', requestId: 'a-1', payloadHash: 'pa-1' });
        await cluster.enqueue({ uid: 'alice', requestId: 'a-2', payloadHash: 'pa-2' });
        await cluster.enqueue({ uid: 'alice', requestId: 'a-3', payloadHash: 'pa-3' });
        await cluster.enqueue({ uid: 'bob', requestId: 'b-1', payloadHash: 'pb-1' });

        const s1 = await cluster.selectNext('fifo', 'disp-1');
        const s2 = await cluster.selectNext('fifo', 'disp-1');
        // Alice is now at perUser cap (2), so FIFO skips a-3 and admits b-1 into the 3rd global slot
        const s3 = await cluster.selectNext('fifo', 'disp-1');

        expect(s1.record.requestId).toBe('a-1');
        expect(s2.record.requestId).toBe('a-2');
        expect(s3.record.requestId).toBe('b-1');
    });

    test('selectNextRoundRobin() rotates across backlogged users via persisted cursor/round-robin', async () => {
        const cluster = await createFairAllocationCluster({ caseId: 'sel-rr-1' });
        // Alice enqueues 3 items first, Bob enqueues 1 item, Carol enqueues 1 item
        await cluster.enqueue({ uid: 'alice', requestId: 'a-1', payloadHash: 'pa-1' });
        await cluster.enqueue({ uid: 'alice', requestId: 'a-2', payloadHash: 'pa-2' });
        await cluster.enqueue({ uid: 'alice', requestId: 'a-3', payloadHash: 'pa-3' });
        await cluster.enqueue({ uid: 'bob', requestId: 'b-1', payloadHash: 'pb-1' });
        await cluster.enqueue({ uid: 'carol', requestId: 'c-1', payloadHash: 'pc-1' });

        const s1 = await cluster.selectNext('round-robin', 'disp-1');
        const s2 = await cluster.selectNext('round-robin', 'disp-1');
        const s3 = await cluster.selectNext('round-robin', 'disp-1');

        // Instead of giving Alice two slots before Bob/Carol get one, Round-Robin rotates alice -> bob -> carol
        expect([s1.record.uid, s2.record.uid, s3.record.uid]).toEqual(['alice', 'bob', 'carol']);
    });
});
