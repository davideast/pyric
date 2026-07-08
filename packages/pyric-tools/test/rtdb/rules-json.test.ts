import { describe, expect, test } from 'bun:test';
import {
  isRtdbRulesJson,
  parseRtdbRulesJson,
} from '../../src/rtdb/rules-json.js';

describe('RTDB rules JSON parser', () => {
  test('accepts a top-level rules object', () => {
    const rules = { rules: { '.read': true } };
    expect(isRtdbRulesJson(rules)).toBe(true);
    expect(parseRtdbRulesJson(rules, () => new Error('invalid'))).toBe(rules);
  });

  test('rejects absent, null, or array rules blocks', () => {
    expect(isRtdbRulesJson(null)).toBe(false);
    expect(isRtdbRulesJson({})).toBe(false);
    expect(isRtdbRulesJson({ rules: null })).toBe(false);
    expect(isRtdbRulesJson({ rules: [] })).toBe(false);
    expect(() =>
      parseRtdbRulesJson({ rules: [] }, () => new Error('caller-specific message')),
    ).toThrow('caller-specific message');
  });
});
