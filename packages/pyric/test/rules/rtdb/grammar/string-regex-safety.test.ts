import { describe, test, expect } from 'bun:test';
import { evaluateRtdbExpression, DataSnapshot } from '../../../../src/rules/rtdb/grammar/simulator.js';

describe('05-rtdb-string-regex-safety-and-flags', () => {
  test('RtdbString.matches does not throw uncaught SyntaxError on malformed regex and returns false', () => {
    const data = new DataSnapshot('abc', '/data');
    let result: unknown;
    expect(() => {
      result = evaluateRtdbExpression("data.val().matches('[unterminated')", { data });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  test('RtdbString.matches parses slash-delimited regex literals with flags', () => {
    const data = new DataSnapshot('HELLO', '/data');
    const result = evaluateRtdbExpression("data.val().matches('/^[a-z]+$/i')", { data });
    expect(result).toBe(true);
  });

  test('RtdbString.replace supports slash-delimited regex literals with flags', () => {
    const data = new DataSnapshot('foo_bar_baz', '/data');
    const result = evaluateRtdbExpression("data.val().replace('/_[a-z]/g', '-x')", { data });
    expect(result).toBe('foo-xar-xaz');
  });
});
