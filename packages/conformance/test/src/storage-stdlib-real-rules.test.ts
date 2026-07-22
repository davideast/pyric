import { describe, expect, test } from 'bun:test';
import {
  injectIntoMatch,
  restoreRulesRelease,
  rulesLiteral,
} from '../../src/storage-stdlib-real-rules.ts';
import { RequestBudget } from '../../src/storage-stdlib-real-budget.ts';

describe('storage stdlib real Rules source support', () => {
  test('Rules literals escape quotes, slashes, and Unicode without interpolation', () => {
    expect(rulesLiteral('a"b\\c雪')).toBe('"a\\"b\\\\c雪"');
  });

  test('source injection fails closed when the canonical match is absent', () => {
    const pattern = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
    expect(injectIntoMatch(
      'service firebase.storage { match /b/{bucket}/o { } }',
      pattern,
      '`match /b/{bucket}/o`',
      '\nprobe\n',
    )).toContain('probe');
    expect(() => injectIntoMatch(
      'service firebase.storage {}',
      pattern,
      '`match /b/{bucket}/o`',
      '\nprobe\n',
    )).toThrow('current rules lack canonical');
  });

  for (const failure of ['patch', 'get'] as const) {
    test(`retries Rules restoration after a first-attempt ${failure} failure`, async () => {
      let failed = false;
      let current = 'rulesets/probe';
      const budget = new RequestBudget({ storage: 0, firestoreWrite: 0, rules: 4, iam: 0 });
      const restored = await restoreRulesRelease(
        { auth: {}, json: {} },
        budget,
        'https://example.test/release',
        'projects/test/releases/firebase.storage/bucket',
        'rulesets/original',
        async (_url, init) => {
          const isPatch = init.method === 'PATCH';
          if (!failed && ((failure === 'patch' && isPatch) || (failure === 'get' && !isPatch))) {
            failed = true;
            throw new Error(`transient ${failure}`);
          }
          if (isPatch) current = 'rulesets/original';
          return { name: 'release', rulesetName: current };
        },
      );
      expect(restored).toBe(true);
      expect(failed).toBe(true);
      expect(budget.snapshot().counts.rules).toBe(4);
    });
  }
});
