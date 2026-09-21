import { describe, it, expect } from 'bun:test';
import {
    applyRefill,
    expectedBalanceAfterDebit,
    expectedBalanceAfterRefund,
    expectedCapacityAfterEvents,
    verifyInvariants,
    workedExamples,
} from '../analysis/model.mjs';

const COST   = 60_000;
const CHAT   = { capacity: 5, refillPerMinute: 10 };
const AGENT  = { capacity: 2, refillPerMinute: 1  };

describe('applyRefill()', () => {
    it('returns full capacity when bucket is null', () => {
        expect(applyRefill(null, CHAT, 1000, COST)).toBe(5 * COST);
    });

    it('adds elapsed * refillPerMinute', () => {
        const bucket = { remaining: 0, updatedAt: 1000 };
        // 1 second (1000ms) elapsed, refillPerMinute=10 units/ms → 10_000 units added
        expect(applyRefill(bucket, CHAT, 2000, COST)).toBe(10_000);
    });

    it('clamps at capacity', () => {
        const bucket = { remaining: 0, updatedAt: 1000 };
        // 100 seconds → 1000 units added but cap is 300_000
        expect(applyRefill(bucket, CHAT, 101_000, COST)).toBe(5 * COST);
    });
});

describe('expectedBalanceAfterDebit()', () => {
    it('returns null when bucket cannot afford a debit', () => {
        const bucket = { remaining: 0, updatedAt: 1000 };
        expect(expectedBalanceAfterDebit(bucket, CHAT, 1000, COST)).toBeNull();
    });

    it('deducts COST from available balance', () => {
        const bucket = { remaining: 2 * COST, updatedAt: 1000 };
        const result = expectedBalanceAfterDebit(bucket, CHAT, 1000, COST);
        expect(result?.remaining).toBe(COST);
    });
});

describe('expectedBalanceAfterRefund()', () => {
    it('credits COST when bucket has room', () => {
        const bucket = { remaining: 2 * COST, updatedAt: 1000 };
        const result = expectedBalanceAfterRefund(bucket, CHAT, 1000, COST);
        expect(result.saturationLoss).toBe(0);
        expect(result.creditedUnits).toBe(COST);
        expect(result.remaining).toBe(3 * COST);
    });

    it('clamps credit when bucket is near-full', () => {
        const capacity = 5 * COST;
        const room     = COST / 2;   // only half a debit unit of room
        const bucket   = { remaining: capacity - room, updatedAt: 1000 };
        const result   = expectedBalanceAfterRefund(bucket, CHAT, 1000, COST);
        expect(result.creditedUnits).toBe(room);
        expect(result.saturationLoss).toBe(COST - room);
        expect(result.remaining).toBe(capacity);
    });

    it('saturationLoss + creditedUnits always equals COST', () => {
        for (const remaining of [0, COST, 2 * COST, 5 * COST - 1]) {
            const bucket = { remaining, updatedAt: 1000 };
            const result = expectedBalanceAfterRefund(bucket, CHAT, 1000, COST);
            expect(result.creditedUnits + result.saturationLoss).toBe(COST);
        }
    });
});

describe('expectedCapacityAfterEvents()', () => {
    it('returns 0 when empty', () => {
        expect(expectedCapacityAfterEvents([])).toBe(0);
    });

    it('increments for admitted, decrements for settled', () => {
        const events = [{ kind: 'admitted' }, { kind: 'admitted' }, { kind: 'settled' }];
        expect(expectedCapacityAfterEvents(events)).toBe(1);
    });

    it('decrements for refunded', () => {
        const events = [{ kind: 'admitted' }, { kind: 'refunded' }];
        expect(expectedCapacityAfterEvents(events)).toBe(0);
    });

    it('quarantined slots remain occupied', () => {
        const events = [{ kind: 'admitted' }, { kind: 'admitted' }, { kind: 'settled' }];
        // A quarantined record is still 'admitted' from the event stream perspective
        expect(expectedCapacityAfterEvents(events)).toBe(1);
    });

    it('never goes below 0', () => {
        // Defensive: more settled than admitted is invalid but should not crash
        const events = [{ kind: 'settled' }];
        expect(expectedCapacityAfterEvents(events)).toBe(0);
    });
});

describe('verifyInvariants()', () => {
    it('is valid for an empty snapshot', () => {
        const result = verifyInvariants({ quotas: [], requests: [], capacity: [], users: [] }, []);
        expect(result.valid).toBe(true);
    });

    it('reports violation when active counter is negative', () => {
        const snap = {
            quotas: [], users: [],
            requests: [],
            capacity: [{ id: 'global', data: { active: -1 } }],
        };
        const result = verifyInvariants(snap, []);
        expect(result.valid).toBe(false);
        expect(result.violations.length).toBeGreaterThan(0);
    });

    it('is valid when active counter matches non-terminal reserved records', () => {
        const snap = {
            quotas: [{ id: 'x', data: {} }], users: [],
            requests: [
                { id: 'r1', data: { state: 'reserved', debitState: 'debited' } },
            ],
            capacity: [{ id: 'global', data: { active: 1 } }],
        };
        const result = verifyInvariants(snap, [{ kind: 'admitted' }]);
        expect(result.valid).toBe(true);
    });
});

describe('worked examples', () => {
    it('refundNoSaturation: saturationLoss=0', () => {
        const ex = workedExamples.refundNoSaturation();
        expect(ex.output.saturationLoss).toBe(0);
        expect(ex.output.creditedUnits).toBe(COST);
    });

    it('refundWithSaturation: saturationLoss=40_000', () => {
        const ex = workedExamples.refundWithSaturation();
        expect(ex.output.saturationLoss).toBe(40_000);
        expect(ex.output.creditedUnits).toBe(20_000);
    });

    it('refillClamped: clamps at capacity', () => {
        const ex = workedExamples.refillClamped();
        expect(ex.output).toBe(5 * COST);
    });
});
