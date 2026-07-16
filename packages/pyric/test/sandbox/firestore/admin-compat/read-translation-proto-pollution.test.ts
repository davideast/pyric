/**
 * Prototype-pollution regression — admin-compat read-path translation.
 * See issue #762 (template #760).
 *
 * `translateValue` rebuilds every read object. The old `out[k] = …` on a
 * fresh `{}` meant a stored field literally named `__proto__` triggered the
 * prototype accessor and polluted `Object.prototype`. It now rebuilds via
 * `Object.fromEntries` (CreateDataProperty semantics), so a `__proto__`
 * field round-trips as a plain own property without touching the shared
 * prototype.
 */
import { describe, test, expect } from 'bun:test';
import { translateReadData } from '../../../../src/firestore/sandbox/admin-compat/read-translation.js';

describe('translateReadData — prototype-pollution guard', () => {
  test('a stored `__proto__` field does NOT pollute Object.prototype', () => {
    // Force a genuine own `__proto__` key (object-literal `{__proto__: …}`
    // sets the prototype instead).
    const malicious: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(malicious, '__proto__', {
      value: { polluted: 'yes' },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const out = translateReadData(malicious);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The malicious key survives as data, but as an own property only.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as Record<string, unknown>).safe).toBe(1);
  });

  test('legitimate nested reads still translate', () => {
    const out = translateReadData({
      a: 1,
      nested: { b: 'two', arr: [1, 2, 3] },
    });
    expect(out).toEqual({ a: 1, nested: { b: 'two', arr: [1, 2, 3] } });
  });
});
