import { describe, expect, test } from 'bun:test';
import {
  isRtdbRulesDocument,
  isRtdbRulesJson,
  parseRtdbRulesJson,
  parseRtdbRulesText,
  stripJsonComments,
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

  test('recognizes RTDB rules document objects by their compiler method', () => {
    expect(isRtdbRulesDocument({ toJSON: () => ({ rules: {} }) })).toBe(true);
    expect(isRtdbRulesDocument({ toJSON: 'not a function' })).toBe(false);
    expect(isRtdbRulesDocument(null)).toBe(false);
  });

  test('strips single-line and block comments without modifying string literal contents', () => {
    const commentedSource = `{
      // Single line comment
      "rules": {
        /* Block comment
           multiline */
        ".read": "url == '//example.com//*test*/'"
      }
    }`;
    const clean = stripJsonComments(commentedSource);
    expect(clean).not.toContain('// Single line comment');
    expect(clean).not.toContain('/* Block comment');
    expect(clean).toContain('"url == \'\/\/example.com\/\/*test*\/\'"');
    const parsed = parseRtdbRulesText(commentedSource, (err) => err);
    expect(parsed).toEqual({
      rules: {
        '.read': "url == '//example.com//*test*/'",
      },
    });
  });
});
