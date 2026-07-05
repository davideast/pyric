/**
 * Prototype-pollution regression — Firestore field-path merge engine.
 * See issue #762 (template #760).
 *
 * `setLeaf` walks caller-controlled FieldPath segments into a plain JS
 * object; `isPlainObject(Object.prototype) === true` (its `proto === null`
 * branch) let the walk step INTO the shared prototype. A dot-path key like
 * `"__proto__.polluted"` (updateDoc) or a `{__proto__: …}` map value
 * (setDoc merge) would otherwise poison `Object.prototype` process-wide.
 * The engine now rejects `__proto__`/`prototype`/`constructor` segments and
 * reads intermediates own-only.
 */
import { describe, test, expect } from 'bun:test';
import { applyUpdate, applyMerge } from '../../../src/sandbox/firestore/field-merge.js';

describe('field-merge — prototype-pollution guard', () => {
  test('updateDoc `__proto__.x` dot-path does NOT pollute Object.prototype', () => {
    expect(() => applyUpdate({}, { '__proto__.polluted': 'yes' })).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('updateDoc nested `a.__proto__.x` path does NOT pollute', () => {
    expect(() => applyUpdate({}, { 'a.__proto__.polluted': 'yes' })).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('setDoc-merge with a genuine `__proto__` map key does NOT pollute', () => {
    const resolved: Record<string, unknown> = {};
    Object.defineProperty(resolved, '__proto__', {
      value: { polluted: 'yes' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => applyMerge({}, resolved)).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('mergeFields targeting `constructor` is rejected', () => {
    expect(() => applyMerge({}, { constructor: 'x' }, ['constructor'])).toThrow(
      /constructor/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('legitimate updateDoc dot-path writes still work (siblings preserved)', () => {
    const out = applyUpdate({ a: { c: 1 } }, { 'a.b': 2 });
    expect(out).toEqual({ a: { c: 1, b: 2 } });
  });

  test('legitimate setDoc-merge nested maps still deep-merge', () => {
    const out = applyMerge({ a: { c: 1 } }, { a: { b: 2 } });
    expect(out).toEqual({ a: { c: 1, b: 2 } });
  });
});
