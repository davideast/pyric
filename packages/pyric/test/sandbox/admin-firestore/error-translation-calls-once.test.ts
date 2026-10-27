/**
 * The error-translation proxy calls each wrapped method exactly once,
 * whatever it returns (#1203). It used to run the method inside the
 * provenance window and fall back to a second call when the result was
 * nullish, so a method returning `undefined` or `null` ran twice.
 *
 * This file imports `pyric/sandbox/*` from the package's dist, so run
 * `scripts/build.sh --packages-only` after editing the sandbox sources.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { wrapWithErrorTranslation } from '../../../src/sandbox/admin-firestore/error-translation.js';

test('a wrapped method runs once whether it returns undefined, null, 0, false, an empty string or an object', () => {
  const sandbox = initializeSandbox();
  try {
    const calls: Record<string, number> = {};
    const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
    const target = {
      returnsUndefined() { count('undefined'); return undefined; },
      returnsNull() { count('null'); return null; },
      returnsZero() { count('zero'); return 0; },
      returnsFalse() { count('false'); return false; },
      returnsEmptyString() { count('empty string'); return ''; },
      returnsObject() { count('object'); return {}; },
    };
    const wrapped = wrapWithErrorTranslation(target, sandbox.withAuth(null));
    expect(wrapped.returnsUndefined()).toBeUndefined();
    expect(wrapped.returnsNull()).toBeNull();
    expect(wrapped.returnsZero()).toBe(0);
    expect(wrapped.returnsFalse()).toBe(false);
    expect(wrapped.returnsEmptyString()).toBe('');
    expect(wrapped.returnsObject()).toEqual({});
    expect(calls).toEqual({ undefined: 1, null: 1, zero: 1, false: 1, 'empty string': 1, object: 1 });
  } finally {
    getInternalEnv(sandbox).dispose();
  }
});
