import { describe, expect, test } from 'bun:test';
import { serverTimestamp as rulesServerTimestamp } from '../../../src/rules/index.js';
import { serverTimestamp as dbServerTimestamp } from '../../../src/database/index.js';
import {
  isServerTimestampSentinel,
  resolveSentinels,
} from '../../../src/database/sandbox/sentinels.js';

describe('sentinels', () => {
  test('recognizes serverTimestamp sentinels from pyric/database and pyric/rules (CON-3)', () => {
    expect(isServerTimestampSentinel(dbServerTimestamp())).toBe(true);
    expect(isServerTimestampSentinel(rulesServerTimestamp())).toBe(true);
    expect(isServerTimestampSentinel({ $sentinel: 'rules.serverTimestamp' })).toBe(true);
    expect(isServerTimestampSentinel({ createdAt: 123 })).toBe(false);
    expect(isServerTimestampSentinel(null)).toBe(false);
  });

  test('resolveSentinels replaces pyric/rules and pyric/database serverTimestamp sentinels with now', () => {
    const now = 1779075391118;
    expect(
      resolveSentinels(
        {
          fromDb: dbServerTimestamp(),
          fromRules: rulesServerTimestamp(),
          fromRulesTag: { $sentinel: 'rules.serverTimestamp' },
          nested: [rulesServerTimestamp(), { '.value': rulesServerTimestamp(), '.priority': 1 }],
        },
        now,
      ),
    ).toEqual({
      fromDb: now,
      fromRules: now,
      fromRulesTag: now,
      nested: [now, { '.value': now, '.priority': 1 }],
    });
  });
});
