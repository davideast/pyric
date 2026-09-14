import { expect, test } from 'bun:test';
import { chipRequestFromEvent } from '../../../src/serve/runtime/chip-traffic.js';
import { rulesEvidenceHtml, rulesSummary } from '../../../src/serve/runtime/chip-rules-evidence.js';
import type { RequestEvent } from 'pyric/sandbox';

function request(): RequestEvent {
  return {
    kind: 'request', id: 'denied', at: 1, evalMs: 1, method: 'get', path: 'docs/a',
    auth: null, result: 'deny', reasons: [],
    rulesEvidence: {
      version: 'original', decision: 'DENY', scope: 'request', truncated: false, paths: [],
      rules: [{ expression: 'false', verdict: 'DENY', checks: [{ expression: 'false', parent: null, state: 'value', value: false }] }],
    },
  };
}

test('traffic snapshots evidence independently of later event mutation', () => {
  const event = request();
  const row = chipRequestFromEvent(event)!;
  event.rulesEvidence!.rules[0]!.expression = 'changed';
  expect(row.rulesEvidence!.rules[0]!.expression).toBe('false');
  expect(rulesSummary(row)).toBe('No applicable rule allowed this request.');
});

test('absence and bypass are explicit rather than inferred from identity', () => {
  const event = request();
  delete event.rulesEvidence;
  expect(rulesSummary(chipRequestFromEvent(event)!)).toContain('unavailable');
  event.rulesDisposition = { kind: 'bypassed', reason: 'admin' };
  expect(rulesSummary(chipRequestFromEvent(event)!)).toContain('bypassed');
});

test('partial evidence cannot imply a different final decision', () => {
  const event = request();
  event.result = 'allow';
  event.rulesEvidence!.decision = 'ALLOW';
  event.rulesEvidence!.truncated = true;
  const row = chipRequestFromEvent(event)!;
  expect(rulesSummary(row)).toBe('A rule allowed this request.');
  expect(rulesEvidenceHtml(row, text => text)).toContain('recording limit');
});

test('unsupported evaluations are not presented as successful requests', () => {
  const event = request();
  event.result = 'unsupported';
  event.rulesEvidence!.decision = 'UNSUPPORTED';
  const row = chipRequestFromEvent(event)!;
  expect(row.verdict).toBe('unsupported');
  expect(rulesSummary(row)).toContain('could not determine');
});

test('deciding checks include observed operands and full evaluation preserves helper context', () => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: 'version >= 0', parent: null, state: 'value', value: false },
    { expression: 'version', parent: 0, state: 'value', value: -1, helper: 'validVersion', binding: 'version' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain('-1');
  expect(html).toContain('<dt>Function</dt>');
  expect(html).toContain('validVersion()');
  expect(html).toContain('<dt>Variable</dt>');
});

test('unsupported proof is not erased by a false residual', () => {
  const event = request();
  event.rulesEvidence!.scope = 'query-residual';
  event.rulesEvidence!.rules[0]!.line = 5;
  event.rulesEvidence!.queryProof = { kind: 'unsupported-predicate', failures: [] };
  const row = chipRequestFromEvent(event)!;
  expect(rulesSummary(row)).toContain('unsupported');
  const html = rulesEvidenceHtml(row, text => text);
  expect(html).toContain('Residual line 5');
  expect(html).toContain('not the deployed rules');
});

test('primary checks are visible, with one secondary disclosure and no capture identifier', () => {
  const event = request();
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html.indexOf('Checks that failed')).toBeLessThan(html.indexOf('<details'));
  expect(html.match(/<details/g)).toHaveLength(1);
  expect(html).toContain('Rule details');
  expect(html).not.toContain('original');
  expect(html).not.toContain('scalar');
  expect(html).toContain('values shown can still be private');
});

test.each([
  { operator: '&&', value: false, explanation: 'Every check must pass. This earlier check failed' },
  { operator: '||', value: true, explanation: 'Only one check needs to pass. This earlier check passed' },
])('skipped checks explain the captured $operator result', ({ operator, value, explanation }) => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: `canEdit() ${operator} validBudget()`, parent: null, operator, state: 'value', value },
    { expression: 'canEdit()', parent: 0, state: 'value', value },
    { expression: 'validBudget()', parent: 0, state: 'skipped' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain(explanation);
  expect(html).toContain('<dt>Earlier check</dt>');
  expect(html).toContain('aria-label="Earlier check">canEdit()</code>');
});

test('incomplete skipped evidence does not invent a reason', () => {
  const event = request();
  event.rulesEvidence!.rules[0]!.checks = [
    { expression: 'validBudget()', parent: null, state: 'skipped' },
  ];
  const html = rulesEvidenceHtml(chipRequestFromEvent(event)!, text => text);
  expect(html).toContain('The saved record does not explain why this check was skipped.');
  expect(html).not.toContain('<dt>Earlier check</dt>');
});
