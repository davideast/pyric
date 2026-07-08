import { describe, expect, test } from 'bun:test';

import { formatRulesLintSummary } from './RulesLintStrip';

describe('formatRulesLintSummary', () => {
  test('reports a clean ruleset', () => {
    expect(formatRulesLintSummary(false, [])).toBe('rules ok');
  });

  test('counts parse errors as errors', () => {
    expect(formatRulesLintSummary(true, [])).toBe('1 error');
  });

  test('summarizes mixed warning severities', () => {
    expect(
      formatRulesLintSummary(true, [
        { severity: 'warning' },
        { severity: 'error' },
        { severity: 'warning' },
      ]),
    ).toBe('2 errors · 2 warnings');
  });
});
