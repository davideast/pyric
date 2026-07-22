import { describe, expect, test } from 'bun:test';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

const storageSource = `rules_version = '2+modules';
import { broken } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if broken(); }
  }
}`;

describe('resolver dependency cycles', () => {
  test.each([
    [
      'direct recursion',
      `function loop() { return loop().keys().hasAll([]); }
       export function broken() { return loop(); }`,
    ],
    [
      'mutual recursion',
      `function a() { return b(); }
       function b() { return a().matches('x'); }
       export function broken() { return a(); }`,
    ],
  ])('rejects %s through the public resolver', (_name, moduleSource) => {
    const result = resolveModules(storageSource, {
      modules: { './policy': moduleSource },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CIRCULAR_DEPENDENCY');
      expect(result.error.message).toContain('Recursive module function dependency');
    }
  });
});
