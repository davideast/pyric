import { describe, expect, test } from 'bun:test';
import {
  coerceRtdbEditorValue,
  formatRtdbEditorValue,
  inferRtdbEditorType,
  rtdbKeyInputError,
} from '../../../src/rtdb/index.js';

describe('inferRtdbEditorType', () => {
  test('maps scalars to their editor type, everything else to json', () => {
    expect(inferRtdbEditorType('hi')).toBe('string');
    expect(inferRtdbEditorType(3)).toBe('number');
    expect(inferRtdbEditorType(true)).toBe('boolean');
    expect(inferRtdbEditorType(null)).toBe('json');
    expect(inferRtdbEditorType({ a: 1 })).toBe('json');
    expect(inferRtdbEditorType(['a'])).toBe('json');
  });
});

describe('formatRtdbEditorValue', () => {
  test('seeds the text field per type', () => {
    expect(formatRtdbEditorValue('hi', 'string')).toBe('hi');
    expect(formatRtdbEditorValue(3.5, 'number')).toBe('3.5');
    expect(formatRtdbEditorValue(false, 'boolean')).toBe('false');
    expect(formatRtdbEditorValue({ a: 1 }, 'json')).toBe('{"a":1}');
    expect(formatRtdbEditorValue(null, 'json')).toBe('null');
    expect(formatRtdbEditorValue(null, 'string')).toBe('');
  });
});

describe('coerceRtdbEditorValue', () => {
  test('string passes through verbatim', () => {
    expect(coerceRtdbEditorValue('string', ' spaced ')).toEqual({ ok: true, value: ' spaced ' });
  });

  test('number coerces and rejects non-numbers', () => {
    expect(coerceRtdbEditorValue('number', '42')).toEqual({ ok: true, value: 42 });
    expect(coerceRtdbEditorValue('number', ' -3.5 ')).toEqual({ ok: true, value: -3.5 });
    expect(coerceRtdbEditorValue('number', 'abc').ok).toBe(false);
    expect(coerceRtdbEditorValue('number', '').ok).toBe(false);
  });

  test('boolean accepts true/false case-insensitively', () => {
    expect(coerceRtdbEditorValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(coerceRtdbEditorValue('boolean', ' FALSE ')).toEqual({ ok: true, value: false });
    expect(coerceRtdbEditorValue('boolean', 'yes').ok).toBe(false);
  });

  test('json parses literals, treats empty as null, and reports errors', () => {
    expect(coerceRtdbEditorValue('json', '{"a":[1,2]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
    expect(coerceRtdbEditorValue('json', '')).toEqual({ ok: true, value: null });
    expect(coerceRtdbEditorValue('json', '{oops').ok).toBe(false);
  });
});

describe('rtdbKeyInputError', () => {
  test('accepts ordinary keys', () => {
    expect(rtdbKeyInputError('messages')).toBeNull();
    expect(rtdbKeyInputError('user_1-2')).toBeNull();
  });

  test('rejects empty and RTDB-forbidden characters', () => {
    expect(rtdbKeyInputError('')).not.toBeNull();
    expect(rtdbKeyInputError('  ')).not.toBeNull();
    for (const bad of ['a.b', 'a$b', 'a#b', 'a[b', 'a]b', 'a/b']) {
      expect(rtdbKeyInputError(bad)).not.toBeNull();
    }
  });
});
