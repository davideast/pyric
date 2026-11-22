import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rtdbRules } from '../../../src/index.js';
import { compileRtdbRules } from '../../../src/rtdb/compiled-rules.js';
import { checkRtdbRules } from '../../../src/rtdb/constraints/document.js';

interface RecordedDeployCase {
  verdict: 'ACCEPTED' | 'REJECTED';
  error?: string;
}

interface DeployObservation {
  behavior: Record<string, RecordedDeployCase>;
}

const r62Observation = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../../conformance/observations/rtdb-rules/rules-rtdb-r62-deploy-ternary-snapshot-member.json',
    ),
    'utf-8',
  ),
) as DeployObservation;

describe('RTDB load-time check on nullable snapshot ternaries (#1820)', () => {
  test('matches every deploy verdict and error message in rules-rtdb-r62-deploy-ternary-snapshot-member.json', () => {
    const entries = Object.entries(r62Observation.behavior);
    expect(entries.length).toBe(8);

    for (const [expr, recorded] of entries) {
      const result = checkRtdbRules(() =>
        compileRtdbRules({
          rules: { a: { '.read': expr } },
        }),
      );
      if (recorded.verdict === 'ACCEPTED') {
        expect([expr, result.errors]).toEqual([expr, []]);
      } else {
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]?.code).toBe('NOT_AN_OBJECT');
        expect(result.errors[0]?.message).toBe(recorded.error);
      }

      const lintErrors = rtdbRules(JSON.stringify({ rules: { a: { '.read': expr } } }))
        .lint()
        .filter((issue) => issue.severity === 'error' && issue.origin === 'validate');
      if (recorded.verdict === 'ACCEPTED') {
        expect([expr, lintErrors]).toEqual([expr, []]);
      } else {
        expect(lintErrors.map((issue) => issue.message)).toEqual([
          'Invalid property access: target is not an object.',
        ]);
      }
    }
  });

  test('refuses symmetric and nested nullable snapshot ternaries with production text', () => {
    for (const expr of [
      '(false ? null : data.parent()).exists()',
      '(true ? root : null).val() == 1',
      '(true ? (false ? data : null) : newData).hasChildren()',
    ]) {
      const result = checkRtdbRules(() =>
        compileRtdbRules({
          rules: { items: { $id: { '.write': expr } } },
        }),
      );
      expect([expr, result.errors.map((e) => e.message)]).toEqual([
        expr,
        ['Invalid property access: target is not an object.'],
      ]);
    }
  });
});
