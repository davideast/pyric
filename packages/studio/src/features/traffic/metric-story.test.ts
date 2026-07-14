import { describe, expect, it } from 'bun:test';
import type { MetricSeries } from '@pyric/ui/traffic';
import { billableStory, rulesStory } from './metric-story.js';

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
