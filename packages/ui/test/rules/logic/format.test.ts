import { describe, it, expect } from 'bun:test';
import {
  denialReason,
  markRuleLines,
  decidingEvaluation,
  formatValue,
  traceDepth,
  scopeVars,
} from '../../../src/rules/index.js';
import { aliceDeniedUpdate, noMatchDenial, NOTES_RULES } from '../helpers/fixtures.js';

describe('markRuleLines', () => {
  it('marks the deciding allow line deny, the unchecked allow line skip', () => {
    const d = aliceDeniedUpdate();
    const lines = markRuleLines(NOTES_RULES, d.evaluation, d.method);
    const verdictFor = (n: number) => lines.find((l) => l.number === n)?.verdict;
    // Line 6 is `allow update` — the deciding rule.
    expect(verdictFor(6)).toBe('deny');
    // Line 5 is `allow read` — not checked for an update.
    expect(verdictFor(5)).toBe('skip');
    // The match/brace lines carry no verdict.
    expect(verdictFor(4)).toBeUndefined();
  });

  it('attaches a note to skipped lines', () => {
    const d = aliceDeniedUpdate();
    const lines = markRuleLines(NOTES_RULES, d.evaluation, d.method);
    const skipped = lines.find((l) => l.verdict === 'skip');
    expect(skipped?.note).toContain('not checked');
    expect(skipped?.note).toContain('update');
  });
});

describe('denialReason', () => {
  it('names the deciding condition for an evaluated denial', () => {
    const d = aliceDeniedUpdate();
    const reason = denialReason(d.evaluation, d.method, d.path);
    expect(reason).toContain('request.auth.uid == resource.data.owner');
    expect(reason).toContain('denied');
  });

  it('explains a no-match (default-deny) denial', () => {
    const d = noMatchDenial();
    const reason = denialReason(d.evaluation, d.method, d.path);
    expect(reason).toContain('No security rule matched');
    expect(reason).toContain(d.path);
  });
});

describe('decidingEvaluation', () => {
  it('returns the last evaluated rule, undefined for no-match', () => {
    expect(decidingEvaluation(aliceDeniedUpdate().evaluation)?.line).toBe(6);
    expect(decidingEvaluation(noMatchDenial().evaluation)).toBeUndefined();
  });
});

describe('scopeVars', () => {
  it('underlines the leaf keys the rule read', () => {
    const d = aliceDeniedUpdate();
    const scope = scopeVars(d);
    const auth = scope.find((s) => s.name === 'request.auth');
    const existing = scope.find((s) => s.name === 'resource.data');
    expect(auth?.hits).toContain('uid');
    expect(existing?.hits).toContain('owner');
  });

  it('omits scope rows whose payload is absent', () => {
    const d = noMatchDenial();
    const scope = scopeVars(d);
    // No write payload / existing doc for a get — only auth is present.
    expect(scope.map((s) => s.name)).toEqual(['request.auth']);
  });
});

describe('traceDepth', () => {
  it('computes depth from the parent chain', () => {
    const d = aliceDeniedUpdate();
    const trace = d.evaluation[0].expressionTrace!;
    // Root binaryOp has parent null → depth 0.
    expect(traceDepth(trace, 0)).toBe(0);
    // `request.auth.uid` is parent 0 → depth 1.
    const uidIdx = trace.findIndex((e) => e.source === 'request.auth.uid');
    expect(traceDepth(trace, uidIdx)).toBe(1);
  });
});

describe('formatValue', () => {
  it('quotes strings, leaves false/null bare', () => {
    expect(formatValue('alice')).toBe('"alice"');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(42)).toBe('42');
  });
});
