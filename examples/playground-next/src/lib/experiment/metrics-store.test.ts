/** Tests for the metrics NDJSON store (issue M1/#506). Uses a temp file. */
import { describe, test, expect, afterAll } from 'bun:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { appendRecords, readAllRecords, isMetricsRecord, type MetricsRecord } from './metrics-store';

const TMP = resolve(tmpdir(), `pyric-metrics-test-${Date.now()}.ndjson`);
afterAll(() => rmSync(TMP, { force: true }));

function rec(over: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    runId: 'r1',
    ranAt: '2026-06-07T00:00:00Z',
    gitSha: 'abc1234',
    model: { id: 'kimi', endpoint: 'https://or/v1', paid: true },
    strategy: { name: 'react', params: { maxTurns: 12 } },
    fixture: { id: 'tasks-per-user', domain: 'tasks' },
    trial: 0,
    variant: 'baseline',
    correctness: { ok: true, casesPassed: 5, casesTotal: 5 },
    tokens: { in: 112503, out: 11159, cached: 0, reasoning: 0, total: 123662 },
    costUsd: 0.086,
    costSource: 'usage.cost',
    durationMs: 270635,
    turns: 11,
    toolCalls: ['write_file', 'simulate_firestore_write'],
    ...over,
  };
}

describe('metrics store', () => {
  test('append → read round-trips records', () => {
    appendRecords([rec(), rec({ runId: 'r2', strategy: { name: 'draft-validate' } })], TMP);
    const all = readAllRecords(TMP);
    expect(all).toHaveLength(2);
    expect(all[0]!.fixture.id).toBe('tasks-per-user');
    expect(all[1]!.strategy.name).toBe('draft-validate');
    expect(all[0]!.tokens.in).toBe(112503);
  });

  test('appends accumulate (does not clobber)', () => {
    const before = readAllRecords(TMP).length;
    appendRecords([rec({ variant: 'caching' })], TMP);
    expect(readAllRecords(TMP).length).toBe(before + 1);
  });

  test('malformed lines are skipped on read, valid ones survive', () => {
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(TMP, 'not json\n{"partial":true}\n', 'utf8');
    // still readable; junk skipped
    expect(readAllRecords(TMP).length).toBeGreaterThanOrEqual(3);
  });

  test('appendRecords rejects a malformed record', () => {
    expect(() => appendRecords([{ runId: 'x' } as unknown as MetricsRecord], TMP)).toThrow();
  });

  test('isMetricsRecord guards required shape', () => {
    expect(isMetricsRecord(rec())).toBe(true);
    expect(isMetricsRecord({ runId: 'x' })).toBe(false);
    expect(isMetricsRecord(null)).toBe(false);
  });
});
