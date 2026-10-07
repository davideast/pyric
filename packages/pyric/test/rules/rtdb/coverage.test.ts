import { describe, expect, test } from 'bun:test';
import { rtdbRules, renderRtdbCoverage } from '../../../src/rules/index.js';
import { RulesEvaluator } from '../../../src/database/sandbox/rules-eval.js';
import { emptySpec } from '../../../src/database/sandbox/query.js';
import type { RtdbCase, RtdbSimulationSummary } from '../../../src/rules/api/case-types.js';

const ruleset = {
  rules: {
    open: { '.read': 'true' },
    mine: { $uid: { '.read': 'auth.uid == $uid' } },
    admin: { '.read': 'auth.token.admin == true' },
    score: { '.write': 'auth != null', '.validate': 'newData.isNumber() && newData.val() >= 0' },
    runtime: { '.write': 'auth != null', '.validate': "newData.val().toUpperCase() == 'OK'" },
    posts: { '.indexOn': ['author'] },
    unused: { '.indexOn': ['rank'] },
  },
};

function row(summary: RtdbSimulationSummary, path: string, kind: string) {
  const found = summary.coverage.rules.find((r) => r.path === path && r.kind === kind);
  if (found === undefined) throw new Error(`no coverage row for ${path} ${kind}`);
  return found;
}

describe('RTDB rule coverage from simulate', () => {
  test('a suite that exercises two of three read rules reports the third as never evaluated', () => {
    const cases: RtdbCase[] = [
      { expectation: 'ALLOW', operation: 'read', path: '/open' },
      { expectation: 'ALLOW', operation: 'read', path: '/mine/alice', auth: 'alice' },
    ];
    const summary = rtdbRules(ruleset).simulate(cases);
    expect(row(summary, '/open', 'read').status).toBe('allow');
    expect(row(summary, '/mine/$uid', 'read').status).toBe('allow');
    expect(row(summary, '/admin', 'read').status).toBe('never-evaluated');
    expect(summary.coverage.uncovered).toContain('/admin .read');
  });

  test('a rule that only ever denied reports deny, with a per-outcome count', () => {
    const cases: RtdbCase[] = [
      { expectation: 'DENY', operation: 'write', path: '/score', auth: 'alice', newData: -1 },
      { expectation: 'DENY', operation: 'write', path: '/score', auth: 'alice', newData: 'x' },
    ];
    const validate = row(rtdbRules(ruleset).simulate(cases), '/score', 'validate');
    expect(validate.status).toBe('deny');
    expect(validate).toMatchObject({ allow: 0, deny: 2, error: 0, unsupported: 0 });
  });

  test('a rule that allowed and denied is mixed', () => {
    const cases: RtdbCase[] = [
      { expectation: 'ALLOW', operation: 'write', path: '/score', auth: 'alice', newData: 3 },
      { expectation: 'DENY', operation: 'write', path: '/score', auth: 'alice', newData: -1 },
    ];
    const validate = row(rtdbRules(ruleset).simulate(cases), '/score', 'validate');
    expect(validate.status).toBe('mixed');
    expect(validate).toMatchObject({ allow: 1, deny: 1 });
  });

  test('a rule that raised at evaluation reports error', () => {
    const cases: RtdbCase[] = [
      { expectation: 'DENY', operation: 'write', path: '/runtime', auth: 'alice', newData: 5 },
    ];
    const validate = row(rtdbRules(ruleset).simulate(cases), '/runtime', 'validate');
    expect(validate.status).toBe('error');
    expect(validate.error).toBe(1);
  });

  test('a read cascade stops at the granting rule, so rules below it stay unevaluated', () => {
    const rules = { rules: { a: { '.read': 'true', b: { '.read': 'auth != null' } } } };
    const summary = rtdbRules(rules).simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a/b' }]);
    expect(row(summary, '/a', 'read').status).toBe('allow');
    expect(row(summary, '/a/b', 'read').status).toBe('never-evaluated');
  });

  test('.indexOn nodes are listed and never evaluated by simulate cases', () => {
    const summary = rtdbRules(ruleset).simulate([{ expectation: 'ALLOW', operation: 'read', path: '/open' }]);
    expect(row(summary, '/posts', 'indexOn').status).toBe('never-evaluated');
  });

  test('the summary counts covered and never-evaluated nodes per file', () => {
    const summary = rtdbRules(ruleset).simulate([{ expectation: 'ALLOW', operation: 'read', path: '/open' }]);
    const total = summary.coverage.rules.length;
    expect(summary.coverage.files).toHaveLength(1);
    const [file] = summary.coverage.files;
    expect(file.total).toBe(total);
    expect(file.covered).toBe(1);
    expect(file.neverEvaluated).toBe(total - 1);
  });

  test('rules source text attaches the line of each rule key', () => {
    const source = JSON.stringify(ruleset, null, 2);
    const handle = rtdbRules(ruleset);
    const summary = handle.simulate([{ expectation: 'ALLOW', operation: 'read', path: '/open' }]);
    const withLines = handle.coverage(summary.cases, { file: 'database.rules.json', source });
    const expectedLine = source.split('\n').findIndex((l) => l.includes('"open"')) + 2;
    expect(withLines.rules.find((r) => r.path === '/open')?.line).toBe(expectedLine);
    expect(withLines.rules.find((r) => r.path === '/mine/$uid')?.line).toBeGreaterThan(expectedLine);
    expect(withLines.files[0].file).toBe('database.rules.json');
    expect(summary.coverage.rules.every((r) => r.line === undefined)).toBe(true);
  });

  test('renderRtdbCoverage names each never-evaluated rule', () => {
    const summary = rtdbRules(ruleset).simulate([{ expectation: 'ALLOW', operation: 'read', path: '/open' }]);
    const text = renderRtdbCoverage(summary.coverage);
    expect(text).toContain('/open .read');
    expect(text).toContain('never evaluated');
    expect(text).toContain('/admin .read');
  });
});

describe('RTDB rule coverage from sandbox evaluation', () => {
  test('a recording evaluator reports rules it evaluated and index declarations a query used', () => {
    const evaluator = new RulesEvaluator();
    evaluator.setRules(ruleset);
    const recorder = evaluator.recordCoverage();
    if (recorder === null) throw new Error('rules are loaded, so recording must start');
    evaluator.check('read', '/open', { auth: null, mockData: {} });
    const spec = emptySpec();
    spec.orderBy = { kind: 'child', path: 'author' };
    evaluator.missingQueryIndex('/posts', spec);
    const summary = recorder.summarize();
    const find = (path: string, kind: string) => summary.rules.find((r) => r.path === path && r.kind === kind);
    expect(find('/open', 'read')?.status).toBe('allow');
    expect(find('/posts', 'indexOn')?.status).toBe('allow');
    expect(find('/unused', 'indexOn')?.status).toBe('never-evaluated');
  });
});
