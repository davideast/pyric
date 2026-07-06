/**
 * EFF1 — ledger writer unit tests. Pure row-building (composition,
 * duplicate-prompt detection, tuple hashing, sequence/duration) plus the
 * NDJSON append/read roundtrip in a temp dir.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmRequestTrace, LlmResponseTrace } from '@inbrowser/agent';
import {
  appendRequestRows,
  appendToolRows,
  buildRequestRow,
  createLedgerTracer,
  createToolLedgerRecorder,
  estTokens,
  fnv1a,
  readRequestRows,
  readToolRows,
  simulateTupleHash,
  stableStringify,
} from './efficiency-ledgers';

const META = { runId: 'run-1', fixture: 'fx', strategy: 'react', model: 'stub' };

const PROMPT = 'Build a small app where users read only their own profile.';

/** A request trace shaped exactly like the @inbrowser/agent react loop
 *  produces it — INCLUDING the H3 bug signature: the session appends the
 *  user msg to history, then buildMessages appends input.prompt again, so
 *  the current prompt appears twice. */
function makeRequest(iteration: number, withToolResult = false): LlmRequestTrace {
  const messages: LlmRequestTrace['messages'] = [
    { role: 'system', text: 'You are the playground agent. '.repeat(20) },
    { role: 'user', text: PROMPT }, // history copy (session.run appended it)
    { role: 'user', text: PROMPT }, // buildMessages' input.prompt copy — the bug
  ];
  if (withToolResult) {
    messages.push(
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: '/workspace/firestore.rules', content: 'rules...' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'write_file', text: '', resultJson: JSON.stringify({ ok: true, summary: 'wrote', data: { bytes: 4000, blob: 'x'.repeat(4000) } }) },
    );
  }
  return {
    requestId: `t-1#${iteration}`,
    turnId: 't-1',
    iteration,
    ts: 1000 + iteration,
    systemPrompt: 'You are the playground agent. '.repeat(20),
    messages,
    tools: [],
    llm: { id: 'stub', supportsTools: true },
  };
}

describe('estTokens', () => {
  test('chars/4, ceil, empty-safe', () => {
    expect(estTokens('')).toBe(0);
    expect(estTokens(undefined)).toBe(0);
    expect(estTokens('abcd')).toBe(1);
    expect(estTokens('abcde')).toBe(2);
  });
});

describe('buildRequestRow', () => {
  test('detects the duplicated current prompt (H3) and splits composition', () => {
    const row = buildRequestRow(META, makeRequest(0));
    expect(row.duplicatePromptTokens).toBe(estTokens(PROMPT));
    expect(row.composition.currentPrompt).toBe(estTokens(PROMPT));
    expect(row.composition.system).toBeGreaterThan(0);
    expect(row.composition.resentToolResults).toBe(0);
    // The duplicate copy lands in history (it IS re-sent history).
    expect(row.composition.history).toBe(estTokens(PROMPT));
    expect(row.totalEstTokens).toBe(
      row.composition.system + row.composition.history + row.composition.resentToolResults + row.composition.currentPrompt,
    );
    expect(row.usageSource).toBe('estimate');
    expect(row.runId).toBe('run-1');
    expect(row.fixture).toBe('fx');
  });

  test('no duplicate → duplicatePromptTokens 0', () => {
    const req = makeRequest(0);
    req.messages.splice(1, 1); // drop the history copy
    const row = buildRequestRow(META, req);
    expect(row.duplicatePromptTokens).toBe(0);
  });

  test('tool-result messages are counted as resentToolResults', () => {
    const row = buildRequestRow(META, makeRequest(1, true));
    expect(row.toolResultMessageCount).toBe(1);
    expect(row.composition.resentToolResults).toBeGreaterThan(1000); // the 4k blob
  });

  test('provider usage wins when the paired response carries it', () => {
    const res: LlmResponseTrace = {
      requestId: 't-1#0',
      ts: 2000,
      text: 'done',
      thinking: 'x'.repeat(400),
      toolCalls: [],
      usage: { promptTokens: 123, outputTokens: 45, cachedTokens: 6 },
    };
    const row = buildRequestRow(META, makeRequest(0), res);
    expect(row.usageSource).toBe('provider');
    expect(row.tokensIn).toBe(123);
    expect(row.tokensOut).toBe(45);
    expect(row.cached).toBe(6);
    // Reasoning is ALWAYS estimated — the trace usage shape has no
    // reasoningTokens field (tracer gap).
    expect(row.reasoning).toBe(100);
  });

  test('SF-S0a cadence tag defaults to the strategy name when unset', () => {
    const row = buildRequestRow(META, makeRequest(0)); // META has no cadence
    expect(row.cadence).toBe('react'); // == strategy for leaf arms
  });

  test('SF-S0a cadence tag overrides the strategy name when set (routed arm)', () => {
    // The `routed` arm dispatches to a cadence the arm name doesn't reveal.
    const row = buildRequestRow(
      { ...META, strategy: 'routed', cadence: 'draft-validate' },
      makeRequest(0),
    );
    expect(row.strategy).toBe('routed');
    expect(row.cadence).toBe('draft-validate');
  });

  test('SF-S0a cadence reflects escalation (routed→react)', () => {
    const row = buildRequestRow(
      { ...META, strategy: 'routed', cadence: 'react' },
      makeRequest(0),
    );
    expect(row.cadence).toBe('react');
  });

  test('no strategy and no cadence → cadence omitted', () => {
    const row = buildRequestRow({ runId: 'r' }, makeRequest(0));
    expect(row.cadence).toBeUndefined();
  });
});

describe('createLedgerTracer', () => {
  test('pairs requests with responses; unpaired requests degrade to estimates', () => {
    const tracer = createLedgerTracer(META);
    tracer.emit({ kind: 'llm_request', data: makeRequest(0) });
    tracer.emit({
      kind: 'llm_response',
      data: { requestId: 't-1#0', ts: 1500, text: 'ok', thinking: '', toolCalls: [], usage: { promptTokens: 80, outputTokens: 40 } },
    });
    tracer.emit({ kind: 'llm_request', data: makeRequest(1, true) }); // no response (mid-stream error)
    const rows = tracer.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.usageSource).toBe('provider');
    expect(rows[0]!.tokensIn).toBe(80);
    expect(rows[1]!.usageSource).toBe('estimate');
    expect(rows[1]!.iteration).toBe(1);
  });
});

describe('simulateTupleHash', () => {
  test('identical tuples hash equal regardless of key order', () => {
    const a = simulateTupleHash('simulate_firestore_write', { method: 'get', path: 'users/alice', auth: { uid: 'alice' } });
    const b = simulateTupleHash('simulate_firestore_write', { auth: { uid: 'alice' }, path: 'users/alice', method: 'get' });
    expect(a).toBeDefined();
    expect(a).toBe(b!);
  });
  test('auth shape, path, and method all participate; rules/data do not', () => {
    const base = { method: 'get', path: 'users/alice', auth: { uid: 'alice' } };
    const h = simulateTupleHash('simulate_firestore_write', base)!;
    expect(simulateTupleHash('simulate_firestore_write', { ...base, auth: { uid: 'mallory' } })).not.toBe(h);
    expect(simulateTupleHash('simulate_firestore_write', { ...base, path: 'users/bob' })).not.toBe(h);
    expect(simulateTupleHash('simulate_firestore_write', { ...base, method: 'delete' })).not.toBe(h);
    expect(simulateTupleHash('simulate_firestore_write', { ...base, rules: 'whole ruleset re-passed' })).toBe(h);
    expect(simulateTupleHash('simulate_firestore_write', { ...base, data: { a: 1 } })).toBe(h);
  });
  test('non-simulate tools get no tuple', () => {
    expect(simulateTupleHash('write_file', { path: '/x' })).toBeUndefined();
  });
  test('stableStringify sorts keys recursively; fnv1a is stable', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

describe('createToolLedgerRecorder', () => {
  test('sequence per turn, sizes, path, duration, ok', () => {
    const rec = createToolLedgerRecorder(META);
    rec.onToolStarted({ turnId: 't-1', callId: 'c1', name: 'write_file', args: { path: '/workspace/a.ts', content: 'x'.repeat(800) } }, 1000);
    rec.onToolStarted({ turnId: 't-1', callId: 'c2', name: 'simulate_firestore_write', args: { method: 'get', path: 'users/alice', auth: null } }, 1100);
    rec.onToolStarted({ turnId: 't-2', callId: 'c3', name: 'list_files', args: {} }, 1200);
    rec.onToolFinished({ turnId: 't-1', callId: 'c1', result: { ok: true, summary: 'wrote', data: { bytes: 800 } } }, 1250);
    rec.onToolFinished({ turnId: 't-1', callId: 'c2', result: { ok: false, summary: 'DENY' } }, 1300);
    const rows = rec.rows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sequenceIndex)).toEqual([1, 2, 1]); // resets per turn
    expect(rows[0]!.path).toBe('/workspace/a.ts');
    expect(rows[0]!.argsBytes).toBeGreaterThan(800);
    expect(rows[0]!.resultTokensEst).toBeGreaterThan(0);
    expect(rows[0]!.durationMs).toBe(250);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[1]!.tupleHash).toBeDefined();
    expect(rows[1]!.ok).toBe(false);
    // c3 never finished — sizes stay 0, no duration.
    expect(rows[2]!.resultTokensEst).toBe(0);
    expect(rows[2]!.durationMs).toBeUndefined();
  });
});

describe('NDJSON stores', () => {
  test('append + read roundtrip; malformed lines skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eff1-'));
    const reqFile = join(dir, 'request-ledger.ndjson');
    const toolFile = join(dir, 'tool-ledger.ndjson');

    const tracer = createLedgerTracer(META);
    tracer.emit({ kind: 'llm_request', data: makeRequest(0) });
    appendRequestRows(tracer.rows(), reqFile);
    appendRequestRows(tracer.rows(), reqFile); // append-only: second batch adds
    appendFileSync(reqFile, '{not json\n', 'utf8'); // survive partial writes

    const rec = createToolLedgerRecorder(META);
    rec.onToolStarted({ turnId: 't-1', callId: 'c1', name: 'write_file', args: { path: '/workspace/a.ts', content: 'hi' } }, 1);
    rec.onToolFinished({ turnId: 't-1', callId: 'c1', result: { ok: true } }, 2);
    appendToolRows(rec.rows(), toolFile);

    expect(readRequestRows(reqFile)).toHaveLength(2);
    expect(readToolRows(toolFile)).toHaveLength(1);
    expect(readFileSync(reqFile, 'utf8').trim().split('\n')).toHaveLength(3);
    // Missing file reads as empty, never throws.
    expect(readRequestRows(join(dir, 'nope.ndjson'))).toEqual([]);
  });

  test('malformed rows are rejected at append time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eff1-'));
    expect(() => appendToolRows([{ runId: 'x' } as never], join(dir, 't.ndjson'))).toThrow(/malformed/);
  });
});
