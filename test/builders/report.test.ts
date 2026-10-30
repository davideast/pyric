import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBuilderReport, readBuilderReport } from './report.ts';
import { usageFrom } from './usage.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'report-valid.json');
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

function errorsFor(report: Record<string, unknown>): string[] {
  const parsed = parseBuilderReport(report);
  return parsed.ok ? [] : parsed.errors;
}

describe('parseBuilderReport', () => {
  test('accepts the fixture report', () => {
    expect(errorsFor(fixture())).toEqual([]);
  });

  test('rejects the fields only the harness writes', () => {
    expect(errorsFor({ ...fixture(), network: [], usage: { costUsd: 0 } })).toEqual(["(top level): Unrecognized key(s) in object: 'network', 'usage'"]);
  });

  test('takes only the three step results and the three refusal results', () => {
    const report = fixture();
    const [step] = report.steps as Record<string, unknown>[];
    const [refusal] = report.refusals as Record<string, unknown>[];
    expect(errorsFor({ ...report, steps: [{ ...step, result: 'skipped' }] })[0]).toStartWith('steps.0.result: Invalid enum value');
    expect(errorsFor({ ...report, refusals: [{ ...refusal, result: 'denied' }] })[0]).toStartWith('refusals.0.result: Invalid enum value');
  });

  test('requires distinct problem ids, and lets a problem cite no doc', () => {
    const report = fixture();
    const [problem] = report.problems as Record<string, unknown>[];
    expect(errorsFor({ ...report, problems: [problem, problem] })).toEqual(['problems: problem ids must be distinct']);
    expect(errorsFor({ ...report, problems: [{ ...problem, docsLedMeToExpect: null }] })).toEqual([]);
  });

  test('takes stuck as null or with every field', () => {
    expect(errorsFor({ ...fixture(), stuck: { where: 'step 2', lastError: 'EADDRINUSE', whatIWouldTryNext: 'another port' } })).toEqual([]);
    expect(errorsFor({ ...fixture(), stuck: { where: 'step 2' } })).toEqual(['stuck.lastError: Required', 'stuck.whatIWouldTryNext: Required']);
  });
});

describe('readBuilderReport', () => {
  test('says whether the report is valid, missing or invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'builders-report-'));
    expect(readBuilderReport(join(dir, 'report.json')).state).toBe('missing');
    writeFileSync(join(dir, 'report.json'), '{"steps":');
    expect(readBuilderReport(join(dir, 'report.json'))).toMatchObject({ state: 'invalid', report: null });
    writeFileSync(join(dir, 'report.json'), readFileSync(FIXTURE));
    expect(readBuilderReport(join(dir, 'report.json'))).toMatchObject({ state: 'valid', errors: [] });
  });
});

describe('usageFrom', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 12, total_cost_usd: 0.4321, usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 } };

  test('reads the last result line claude printed, among other output', () => {
    const output = ['▸ starting', JSON.stringify({ ...result, total_cost_usd: 0.1 }), 'stderr noise', JSON.stringify(result), ''].join('\n');
    expect(usageFrom(output)).toEqual({ tokens: { input: 1000, output: 200, cacheCreation: 50, cacheRead: 9000 }, costUsd: 0.4321, turns: 12, ending: 'success' });
  });

  test('keeps the ending claude stopped on, and counts absent cache tokens as zero', () => {
    const usage = { input_tokens: 1, output_tokens: 2 };
    expect(usageFrom(JSON.stringify({ ...result, subtype: 'error_max_budget_usd', usage }))).toMatchObject({ ending: 'error_max_budget_usd', tokens: { cacheCreation: 0, cacheRead: 0 } });
  });

  test('is null when no line is a result', () => {
    expect(usageFrom('')).toBeNull();
    expect(usageFrom('{"type":"assistant"}\n{ cut short')).toBeNull();
  });
});
