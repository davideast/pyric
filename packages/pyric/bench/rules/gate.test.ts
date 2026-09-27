import { describe, expect, test } from 'bun:test';
import { compareToBaseline, summarize, type BenchReport, type StageRow } from './gate.ts';

function report(rows: StageRow[]): BenchReport {
  return {
    version: 1,
    recordedAt: '2026-09-27T00:00:00.000Z',
    machine: { platform: 'test', arch: 'test', cpu: 'test', memoryGiB: 0, bun: '0' },
    settings: { warmup: 0, iterations: 0, coldSamples: 0, rounds: 1 },
    rows,
  };
}

const timed = (subject: string, stage: string, median: number): StageRow =>
  ({ subject, stage, kind: 'timed', median, p95: median, p99: median, samples: 1 });

describe('rules benchmark gate', () => {
  test('summarize reports nearest-rank median, p95 and p99 in microseconds', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000);
    expect(summarize(samples)).toEqual({ median: 50, p95: 95, p99: 99, samples: 100 });
  });

  test('a median past the margin regresses; one inside it passes', () => {
    const base = report([timed('a', 'evaluate', 100), timed('b', 'evaluate', 100)]);
    const now = report([timed('a', 'evaluate', 126), timed('b', 'evaluate', 124)]);
    const result = compareToBaseline(base, now, 0.25);
    expect(result.regressions).toEqual(['a :: evaluate: 100 us -> 126 us (+26.0%)']);
  });

  test('the absolute floor keeps sub-microsecond stages from failing on jitter', () => {
    const base = report([timed('a', 'compile', 0.2)]);
    const now = report([timed('a', 'compile', 0.9)]);
    expect(compareToBaseline(base, now, 0.25, 1).regressions).toEqual([]);
  });

  test('a derived row is reported, never gated', () => {
    const derived = (median: number): StageRow => ({ subject: 'a', stage: 'compile', kind: 'derived', median });
    expect(compareToBaseline(report([derived(10)]), report([derived(100)])).regressions).toEqual([]);
  });

  test('a count row regresses on any increase', () => {
    const count = (n: number): StageRow => ({ subject: 'a', stage: 'simulator nodes', kind: 'count', count: n });
    expect(compareToBaseline(report([count(10)]), report([count(11)])).regressions).toEqual(['a :: simulator nodes: 10 -> 11']);
    expect(compareToBaseline(report([count(10)]), report([count(9)])).improvements).toHaveLength(1);
  });

  test('stages in only one report are listed, not failed', () => {
    const result = compareToBaseline(report([timed('a', 'x', 1)]), report([timed('b', 'x', 1)]));
    expect(result).toEqual({ regressions: [], improvements: [], missing: ['a :: x'], added: ['b :: x'] });
  });
});
