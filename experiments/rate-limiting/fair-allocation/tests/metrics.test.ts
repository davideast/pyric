import { describe, expect, test } from 'bun:test';
import { jainsFairnessIndex, quantiles, summarizeVariantOutcomes } from '../analysis/metrics.mjs';

describe('fairness metrics & accounting (metrics.mjs)', () => {
    test('jainsFairnessIndex() returns 1.0 for equal allocation and 1/n for single-user monopoly', () => {
        const equal = jainsFairnessIndex([10, 10, 10]);
        expect(equal.index).toBe(1);
        expect(equal.n).toBe(3);

        const monopoly = jainsFairnessIndex([30, 0, 0]);
        expect(monopoly.index).toBe(0.3333);
    });

    test('quantiles() reports exact count, p50, p95, and max', () => {
        const q = quantiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
        expect(q.count).toBe(10);
        expect(q.p50).toBe(50);
        expect(q.p95).toBe(100);
        expect(q.max).toBe(100);
    });

    test('summarizeVariantOutcomes() tracks backlogged fairness and quiet-cohort fulfillment separately', () => {
        const records = [
            { uid: 'alice', queueAdmitted: true, executionAdmitted: true, terminalState: 'completed', queueWaitMs: 50, endToEndMs: 250 },
            { uid: 'alice', queueAdmitted: true, executionAdmitted: true, terminalState: 'completed', queueWaitMs: 100, endToEndMs: 300 },
            { uid: 'bob', queueAdmitted: true, executionAdmitted: true, terminalState: 'completed', queueWaitMs: 20, endToEndMs: 220 },
        ];
        const summary = summarizeVariantOutcomes(records, {
            backloggedUids: ['alice'],
            quietUids: ['bob'],
        });
        expect(summary.fairness.index).toBe(1);
        expect(summary.quietCohort.bob.fulfillmentRate).toBe(1);
        expect(summary.quietCohort.bob.queueWaitMs.max).toBe(20);
    });
});
