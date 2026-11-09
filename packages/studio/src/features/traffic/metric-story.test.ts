import { describe, expect, it } from 'bun:test';
import type { MetricSeries } from '@pyric/ui/traffic';
import { billableStory, liveRulesStory, rtdbTransferStory, rulesStory } from './metric-story.js';

function series(reads: number, writes: number, deletes: number): MetricSeries[] {
  return [
    { key: 'reads', label: 'Read ops', values: [], total: reads },
    { key: 'writes', label: 'Writes', values: [], total: writes },
    { key: 'deletes', label: 'Deletes', values: [], total: deletes },
  ];
}

describe('billableStory', () => {
  it('leads with the observed total and largest share', () => {
    expect(billableStory(series(8, 1, 1))).toEqual({
      total: 10,
      headline: '10 observed billable operations',
      finding: 'Read operations accounted for 80% of activity in this window.',
    });
  });

  it('describes a tie without choosing a false leader', () => {
    expect(billableStory(series(2, 2, 1)).finding).toBe(
      'Read operations and writes tied for the largest share of activity in this window.',
    );
  });

  it('has an observed empty-state claim', () => {
    expect(billableStory(series(0, 0, 0))).toEqual({
      total: 0,
      headline: 'No billable activity observed',
      finding: 'Successful reads, writes, and deletes will appear here as they happen.',
    });
  });
});

describe('rulesStory', () => {
  const rulesSeries = (allows: number, denies: number): MetricSeries[] => [
    { key: 'allows', label: 'Allows', values: [], total: allows },
    { key: 'denies', label: 'Denies', values: [], total: denies },
  ];

  it('leads with observed evaluations and their largest share', () => {
    expect(rulesStory(rulesSeries(3, 1))).toEqual({
      total: 4,
      headline: '4 observed Rules evaluations',
      finding: 'Allowed requests accounted for 75% of evaluations in this window.',
    });
  });

  it('does not manufacture a leader for an even split', () => {
    expect(rulesStory(rulesSeries(2, 2)).finding).toBe(
      'Evaluations were split evenly between allowed requests and denied requests.',
    );
  });

  it('describes the empty observed state', () => {
    expect(rulesStory(rulesSeries(0, 0))).toEqual({
      total: 0,
      headline: 'No Rules evaluations observed',
      finding: 'Allow and deny decisions will appear here as Rules evaluate requests.',
    });
  });
});

describe('liveRulesStory', () => {
  const rulesSeries = (allows: number, denies: number): MetricSeries[] => [
    { key: 'allows', label: 'Would allow', values: [], total: allows },
    { key: 'denies', label: 'Would deny', values: [], total: denies },
  ];

  it('uses advisory wording and surfaces drift disagreements and window breakdowns', () => {
    expect(
      liveRulesStory(rulesSeries(3, 1), { driftCount: 1, unevaluatedCount: 0, bypassedCount: 0 }),
    ).toEqual({
      total: 4,
      headline: '4 advisory local Rules evaluations',
      finding: 'Local rules would allow 75% of evaluated requests in this window · 1 disagreed with production.',
    });
    expect(
      liveRulesStory(rulesSeries(11, 10), {
        driftCount: 9,
        unevaluatedCount: 224,
        bypassedCount: 5,
      }),
    ).toEqual({
      total: 21,
      headline: '21 advisory local Rules evaluations',
      finding:
        'Local rules would allow 52% of evaluated requests in this window · 9 disagreed with production (21 evaluated · 224 unevaluated · 5 Admin-bypassed).',
    });
  });

  it('distinguishes unevaluated and Admin-bypassed live requests from an idle window', () => {
    expect(
      liveRulesStory(rulesSeries(0, 0), { driftCount: 0, unevaluatedCount: 2, bypassedCount: 0 }),
    ).toEqual({
      total: 0,
      headline: 'No decided local Rules evaluations',
      finding: '2 observed requests could not be evaluated locally in this window.',
    });
    expect(
      liveRulesStory(rulesSeries(0, 0), { driftCount: 0, unevaluatedCount: 0, bypassedCount: 3 }),
    ).toEqual({
      total: 0,
      headline: 'No client Rules evaluations in this window',
      finding:
        '3 Admin SDK requests bypassed client Security Rules in this window (0 evaluated · 0 unevaluated · 3 Admin-bypassed).',
    });
    expect(
      liveRulesStory(rulesSeries(0, 0), { driftCount: 0, unevaluatedCount: 0, bypassedCount: 0 }),
    ).toEqual({
      total: 0,
      headline: 'No local Rules evaluations observed',
      finding: 'What your local rules would allow or would deny will appear here as live requests arrive.',
    });
  });
});

describe('rtdbTransferStory', () => {
  const transferSeries = (deliveries: number, writes: number, removes: number): MetricSeries[] => [
    { key: 'deliveries', label: 'Deliveries', values: [], total: deliveries },
    { key: 'writes', label: 'Writes', values: [], total: writes },
    { key: 'removes', label: 'Removes', values: [], total: removes },
  ];

  it('summarizes Realtime Database transfer activity separately from document SKUs', () => {
    expect(rtdbTransferStory(transferSeries(3, 1, 0))).toEqual({
      total: 4,
      headline: '4 observed Realtime Database transfers',
      finding: 'Deliveries accounted for 75% of transfer activity in this window.',
    });
    expect(rtdbTransferStory(transferSeries(0, 0, 0)).headline).toBe(
      'No Realtime Database transfers observed',
    );
  });
});
