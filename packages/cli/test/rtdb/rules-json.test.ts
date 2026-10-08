import { describe, expect, test } from 'bun:test';
import {
  isRtdbRulesDocument,
  isRtdbRulesJson,
  parseRtdbRulesJson,
  parseRtdbRulesText,
} from '../../src/rtdb/rules-json.js';
import { stripJsonComments } from 'pyric/sandbox/database';

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

  test('says why rules text is not a rules document', () => {
    expect(() => parseRtdbRulesText('{\n  // open\n  "rules": {', (reason) => reason)).toThrow(/^not valid JSON: /);
    expect(() => parseRtdbRulesText('/* no rules */ {}', (reason) => reason)).toThrow('no top-level "rules" object');
  });

  test('accepts a rule expression that spans lines, as a deployed rules file may', () => {
    const source = [
      '{',
      '  "rules": {',
      '    ".write": "auth.uid !== null',
      '        && !data.exists()"',
      '  }',
      '}',
    ].join('\n');
    const parsed = parseRtdbRulesText(source, (reason) => reason);
    expect(parsed.rules['.write']).toBe('auth.uid !== null\n        && !data.exists()');
  });

  test('accepts trailing commas in objects and arrays, and keeps commas inside strings', () => {
    const source = [
      '{',
      '  "rules": {',
      '    "a": { ".indexOn": ["x", "y",], },',
      '    // a comment after the last member',
      '    "b": { ".read": "\'1,}\' == \'1,]\'" },',
      '  },',
      '}',
    ].join('\r\n');
    const parsed = parseRtdbRulesText(source, (reason) => reason);
    expect(parsed).toEqual({
      rules: {
        a: { '.indexOn': ['x', 'y'] },
        b: { '.read': "'1,}' == '1,]'" },
      },
    });
  });

  test('still rejects a comma with no member before it', () => {
    expect(() => parseRtdbRulesText('{ "rules": { , } }', (reason) => reason)).toThrow(/^not valid JSON: /);
  });
});
