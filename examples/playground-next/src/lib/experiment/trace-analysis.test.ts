/**
 * EFF1 — offline analyzer tests. The committed fixture
 * (`fixtures/trace-export.sample.json`) is a synthetic trace-viewer export
 * with the exact pathologies under test: a fat write_file result (H2),
 * two identical simulate tuples (H5), three whole-file writes to the same
 * path with mostly-unchanged content (H7), and per-call timing/thinking
 * snapshots (H4). H1/H3 use synthesized request-ledger rows because the
 * trace export does not carry message arrays.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LlmRequestTrace, LlmResponseTrace } from '@inbrowser/agent';
import { buildRequestRow, type RequestLedgerRow } from './efficiency-ledgers';
import type { MetricsRecord } from './metrics-store';
import {
  analyze,
  analyzeH1,
  analyzeH2,
  analyzeH3,
  analyzeH4,
  analyzeH5,
  analyzeH6,
  analyzeH7,
  parseTraceExport,
  percentile,
  renderReport,
  samplesFromBundles,
} from './trace-analysis';

const HERE = dirname(new URL(import.meta.url).pathname);
const FIXTURE = resolve(HERE, 'fixtures', 'trace-export.sample.json');
const bundles = parseTraceExport(readFileSync(FIXTURE, 'utf8'));
const samples = samplesFromBundles(bundles);

const META = { runId: 'run-1' };
const PROMPT = 'Build a tasks app with per-user ownership and tests.';

/** A mega-turn: N iterations, each re-sending the duplicated prompt and a
 *  growing pile of tool results — the H1/H3 shape. */
function megaTurnRows(iterations: number): RequestLedgerRow[] {
  const rows: RequestLedgerRow[] = [];
  for (let i = 0; i < iterations; i++) {
    const messages: LlmRequestTrace['messages'] = [
      { role: 'system', text: 's'.repeat(2000) },
      { role: 'user', text: PROMPT },
      { role: 'user', text: PROMPT }, // the H3 duplicate
    ];
    for (let j = 0; j < i; j++) {
      messages.push({ role: 'tool', toolCallId: `c${j}`, name: 'write_file', text: '', resultJson: 'r'.repeat(3000) });
    }
    const req: LlmRequestTrace = {
      requestId: `t-9#${i}`,
      turnId: 't-9',
      iteration: i,
      ts: i,
      systemPrompt: '',
      messages,
      tools: [],
      llm: { id: 'm', supportsTools: true },
    };
    // Constant per-iteration input = Σ/final ratio of exactly `iterations`.
    const res: LlmResponseTrace = {
      requestId: req.requestId,
      ts: i + 1,
      text: 'working',
      thinking: 't'.repeat(2000),
      toolCalls: [],
      usage: { promptTokens: 1000, outputTokens: 100 },
    };
    rows.push(buildRequestRow(META, req, res));
  }
  return rows;
}

describe('parseTraceExport', () => {
  test('reads the committed fixture (JSON array)', () => {
    expect(bundles).toHaveLength(7);
    expect(bundles.filter((b) => b.name === 'write_file')).toHaveLength(4);
  });
  test('accepts {records: [...]} and NDJSON', () => {
    const one = JSON.stringify(bundles[0]);
    expect(parseTraceExport(`{"records": [${one}]}`)).toHaveLength(1);
    expect(parseTraceExport(`${one}\n${one}\n`)).toHaveLength(2);
    expect(parseTraceExport('')).toEqual([]);
    expect(parseTraceExport('"just a string"')).toEqual([]);
  });
});

describe('percentile', () => {
  test('p50/p95 on small arrays', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });
});

describe('H1 — context integral', () => {
  test('mega-turn with constant 1000-token iterations: ratio = N, supported at N≥5', () => {
    const r = analyzeH1(megaTurnRows(6));
    expect(r.verdict).toBe('supported');
    expect(r.headline).toContain('6 iterations');
    expect(r.body).toContain('6.0×');
  });
  test('no rows → insufficient data with an explicit gap', () => {
    const r = analyzeH1([]);
    expect(r.verdict).toBe('insufficient data');
    expect(r.missing).toContain('request-ledger');
  });
});

describe('H2 — payload outliers', () => {
  test('the fat write_file result dominates and is named in the top-10', () => {
    const r = analyzeH2(samples);
    expect(r.verdict).toBe('supported');
    const fat = samples.find((s) => s.turnId === 't-2' && s.sequenceIndex === 1)!;
    expect(fat.resultTokens).toBeGreaterThan(1000); // it IS fat
    // Top-10 table leads with it.
    const firstRow = r.body.split('\n')[2]!;
    expect(firstRow).toContain('write_file');
    expect(firstRow).toContain('/workspace/src/App.tsx');
    // Per-tool p50/p95 table present.
    expect(r.body).toContain('result p95');
  });
});

describe('H3 — duplicate prompt', () => {
  test('quantifies the doubled prompt and supports the hypothesis', () => {
    const rows = megaTurnRows(3);
    const r = analyzeH3(rows);
    expect(r.verdict).toBe('supported');
    expect(rows.every((row) => row.duplicatePromptTokens > 0)).toBe(true);
    expect(r.headline).toContain('3/3 iterations');
  });
  test('refuted when no duplicates exist', () => {
    const rows = megaTurnRows(2).map((row) => ({ ...row, duplicatePromptTokens: 0 }));
    expect(analyzeH3(rows).verdict).toBe('refuted');
  });
});

describe('H4 — reasoning / deliberation', () => {
  test('median deliberation before first tool ≥30s from the fixture timing', () => {
    const r = analyzeH4([], samples);
    // First calls: t-1 at 42s, t-2 at 31s → median 31s ≥ 30s.
    expect(r.verdict).toBe('supported');
    expect(r.body).toContain('thinking tok up to call');
  });
  test('reasoning share from request rows (estimate-flagged)', () => {
    const r = analyzeH4(megaTurnRows(2), []);
    expect(r.headline).toContain('chars/4 estimate');
    expect(r.verdict).toBe('supported'); // 500 est reasoning vs 100 out ≥ 40%
  });
  test('nothing to see → insufficient data', () => {
    expect(analyzeH4([], []).verdict).toBe('insufficient data');
  });
});

describe('H5 — simulate tuple redundancy', () => {
  test('the two identical tuples (shuffled key order) count as one re-run', () => {
    const r = analyzeH5(samples);
    expect(r.verdict).toBe('supported');
    expect(r.headline).toContain('3 simulate calls');
    expect(r.headline).toContain('2 distinct tuples');
    expect(r.headline).toContain('1 redundant');
  });
  test('no simulate calls → insufficient data', () => {
    expect(analyzeH5(samples.filter((s) => !s.tupleHash)).verdict).toBe('insufficient data');
  });
});

describe('H6 — router provenance', () => {
  const record = (routedStrategy?: string): MetricsRecord =>
    ({
      runId: 'r',
      ranAt: '',
      gitSha: '',
      model: { id: 'm', endpoint: '', paid: false },
      strategy: { name: 'routed', params: routedStrategy ? { routedStrategy } : {} },
      fixture: { id: 'tasks-per-user' },
      trial: 0,
      variant: 'baseline',
      correctness: { ok: true, casesPassed: 1, casesTotal: 1 },
      tokens: { in: 1, out: 1, cached: 0, reasoning: 0, total: 2 },
      costUsd: 0,
      costSource: 'none',
      durationMs: 1,
      turns: 1,
      toolCalls: [],
    }) as MetricsRecord;

  test('routed-to-react on DV-eligible fixtures counts as a miss', () => {
    const r = analyzeH6([record('react'), record('draft-validate'), record('draft-validate')]);
    expect(r.verdict).toBe('supported'); // 1/3 = 33% ≥ 20%
    expect(r.headline).toContain('33% miss rate');
  });
  test('no routed runs → insufficient data', () => {
    expect(analyzeH6([]).verdict).toBe('insufficient data');
  });
});

describe('H7 — write churn', () => {
  test('three near-identical rewrites of App.tsx → supported with low ratio', () => {
    const r = analyzeH7(samples);
    expect(r.verdict).toBe('supported');
    expect(r.headline).toContain('4 write_file calls');
    expect(r.body).toContain('/workspace/src/App.tsx | 3');
    // Mean changed-line ratio for the App.tsx rewrites is tiny (1 line of ~52).
    const appRow = r.body.split('\n').find((l) => l.includes('App.tsx'))!;
    const ratio = Number(appRow.split('|')[4]!.trim());
    expect(ratio).toBeLessThanOrEqual(0.35);
  });
  test('without contents (ledger-only), churn counts still report', () => {
    const noContent = samples.map(({ content: _content, ...rest }) => rest);
    const r = analyzeH7(noContent);
    expect(r.verdict).toBe('insufficient data');
    expect(r.missing).toContain('args.content');
  });
});

describe('renderReport', () => {
  test('all seven sections render with verdict lines', () => {
    const report = renderReport({
      requestRows: megaTurnRows(6),
      toolRows: [],
      bundles,
      records: [],
      source: 'fixture',
    });
    for (const h of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) {
      expect(report).toContain(`## ${h} —`);
    }
    expect(report).toContain('| hypothesis | verdict | headline |');
    expect(report).toContain('**supported**');
  });
  test('analyze prefers bundle samples when both sources exist', () => {
    const sections = analyze({ requestRows: [], toolRows: [], bundles, records: [], source: 'x' });
    expect(sections.find((s) => s.hypothesis === 'H7')!.verdict).toBe('supported');
  });
});
