import { describe, it, expect } from 'bun:test';
import { selectDueCandidates } from '../architecture/recovery-claim.mjs';

describe('selectDueCandidates() anti-starvation pagination', () => {
    const records = [
        { id: '1', data: { requestId: 'req-1', state: 'dispatching', leaseUntil: 5000, nextCheckAt: 1000 } },
        { id: '2', data: { requestId: 'req-2', state: 'dispatching', leaseUntil: 5000, nextCheckAt: 1000 } },
        { id: '3', data: { requestId: 'req-3', state: 'dispatching', leaseUntil: 5000, nextCheckAt: 2000 } },
        { id: '4', data: { requestId: 'req-4', state: 'dispatching', leaseUntil: 5000, nextCheckAt: 3000 } },
        { id: '5', data: { requestId: 'req-5', state: 'completed',   leaseUntil: 5000, nextCheckAt: 1000 } },
        { id: '6', data: { requestId: 'req-6', state: 'unknown',     leaseUntil: 5000, nextCheckAt: 1000, quarantineReason: 'provider-unobservable' } },
    ];

    it('excludes terminal and quarantined records from active due scans', () => {
        const { totalEligible } = selectDueCandidates(records, { now: 10000, pageSize: 10 });
        expect(totalEligible).toBe(4);
    });

    it('paginates strictly forward using cursor so page-1 stuck records never starve page-2 records', () => {
        const page1 = selectDueCandidates(records, { now: 10000, pageSize: 2, cursor: null });
        expect(page1.page.map(r => r.requestId)).toEqual(['req-1', 'req-2']);
        expect(page1.nextCursor).toEqual({ nextCheckAt: 1000, requestId: 'req-2' });

        // Even if req-1 and req-2 remain non-terminal in `records`, passing page1.nextCursor returns page 2
        const page2 = selectDueCandidates(records, { now: 10000, pageSize: 2, cursor: page1.nextCursor });
        expect(page2.page.map(r => r.requestId)).toEqual(['req-3', 'req-4']);
        expect(page2.nextCursor).toBeNull();
    });
});
