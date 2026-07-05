/**
 * Prototype-pollution regression — rules simulator `projectAfterState`
 * (update-mode field-path projection). See issue #762 (template #760).
 *
 * `updateMerge`/`setNested` walk caller-controlled dot-path segments into a
 * plain JS object. A payload key like `"__proto__.polluted"` or
 * `"a.__proto__.polluted"` (field names ride in via JSON transports that
 * preserve `__proto__` as a genuine own key) would otherwise write through
 * the shared `Object.prototype` and poison every object in the process.
 * The projection now rejects `__proto__`/`prototype`/`constructor` as a
 * field-path segment.
 */
import { describe, test, expect } from 'bun:test';
import { projectAfterState } from 'pyric/rules';

describe('projectAfterState — prototype-pollution guard', () => {
  test('update with a `__proto__.x` dot-path does NOT pollute Object.prototype', () => {
    expect(() =>
      projectAfterState({ kind: 'update' }, {}, { '__proto__.polluted': 'yes' }),
    ).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('update with a nested `a.__proto__.x` path does NOT pollute', () => {
    expect(() =>
      projectAfterState({ kind: 'update' }, {}, { 'a.__proto__.polluted': 'yes' }),
    ).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('update with a top-level `constructor` / `prototype` key is rejected', () => {
    expect(() =>
      projectAfterState({ kind: 'update' }, {}, { constructor: 'x' }),
    ).toThrow(/constructor/);
    expect(() =>
      projectAfterState({ kind: 'set', merge: true }, {}, { prototype: 'x' }),
    ).toThrow(/prototype/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('legitimate nested field-path updates still work', () => {
    const after = projectAfterState(
      { kind: 'update' },
      { a: { c: 1 } },
      { 'a.b': 2 },
    );
    expect(after).toEqual({ a: { c: 1, b: 2 } });
  });

  test('legitimate set-merge still deep-merges', () => {
    const after = projectAfterState(
      { kind: 'set', merge: true },
      { a: { c: 1 } },
      { a: { b: 2 } },
    );
    expect(after).toEqual({ a: { c: 1, b: 2 } });
  });
});
