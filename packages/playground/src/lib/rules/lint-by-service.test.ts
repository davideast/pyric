import { describe, expect, test } from 'bun:test';

import { lintRulesForPath, rulesServiceForPath } from './lint-by-service';

const VALID_RTDB = JSON.stringify({
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
      },
    },
  },
});

describe('rulesServiceForPath', () => {
  test('json is the Realtime Database, everything else is the Firestore/Storage language', () => {
    expect(rulesServiceForPath('/workspace/database.rules.json')).toBe('rtdb');
    expect(rulesServiceForPath('/workspace/firestore.rules')).toBe('firestore');
    expect(rulesServiceForPath('/workspace/storage.rules')).toBe('firestore');
  });
});

describe('lintRulesForPath', () => {
  test('a valid Realtime Database ruleset has no parse error and no findings', () => {
    const report = lintRulesForPath('/workspace/database.rules.json', VALID_RTDB);
    expect(report.service).toBe('rtdb');
    expect(report.parseError).toBeUndefined();
    expect(report.findings).toEqual([]);
  });

  test('the same JSON is a parse error to the Firestore linter, so dispatch must follow the path', () => {
    const report = lintRulesForPath('/workspace/firestore.rules', VALID_RTDB);
    expect(report.service).toBe('firestore');
    expect(report.parseError).toBeDefined();
  });

  test('a Realtime Database expression that does not parse is an error finding at its path', () => {
    const report = lintRulesForPath(
      '/workspace/database.rules.json',
      JSON.stringify({ rules: { posts: { '.read': 'auth != null &&' } } }),
    );
    const errors = report.findings.filter((f) => f.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.where).toContain('/posts');
    expect(errors[0]!.where).toContain('.read');
  });

  test('a Realtime Database rule that is hardcoded true is a warning', () => {
    const report = lintRulesForPath(
      '/workspace/database.rules.json',
      JSON.stringify({ rules: { '.read': 'true', '.write': 'false' } }),
    );
    expect(report.parseError).toBeUndefined();
    expect(report.findings.some((f) => f.severity === 'warning')).toBe(true);
  });

  test('JSON without a rules object is a parse error', () => {
    const report = lintRulesForPath('/workspace/database.rules.json', '{"other": 1}');
    expect(report.parseError?.message).toContain('"rules"');
  });
});
