import { describe, expect, test } from 'bun:test';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';

function storageSource(moduleName: string, functionName: string, condition = `${functionName}()`): string {
  return `rules_version = '2+modules';
import { ${functionName} } from '${moduleName}';
service firebase.storage {
  match /b/{bucket}/o { match /{path=**} {
    allow read: if ${condition};
  } }
}`;
}

describe('browser module resolver', () => {
  test.each([
    ['built-in key', 'auth', 'isAuthenticated', undefined, ['auth'], ['storage-rules#125']],
    ['conventional path alias', './stdlib/auth.rules', 'isAuthenticated', undefined,
      ['./stdlib/auth.rules'], ['storage-rules#125']],
    ['caller override', 'auth', 'callerPolicy', {
      modules: { auth: 'export function callerPolicy() { return true; }' },
    }, [], []],
    ['caller path-alias override', './stdlib/auth.rules', 'callerPolicy', {
      modules: {
        './stdlib/auth.rules': 'export function callerPolicy() { return true; }',
      },
    }, [], []],
  ] as const)('resolves Storage modules via %s', (
    _description,
    moduleName,
    functionName,
    options,
    bundledModules,
    evidenceIds,
  ) => {
    const result = resolveModulesBrowser(storageSource(moduleName, functionName), options);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    if (result.success) {
      expect(result.data.bundledModules).toEqual(bundledModules);
      expect(result.data.evidenceIds).toEqual(evidenceIds);
    }
  });
  test('rejects source calls to known but unimported exports', () => {
    const options = {
      modules: { './policy': `
        export function foo() { return true; }
        export function bar() { return true; }
      ` },
    };
    const result = resolveModulesBrowser(storageSource('./policy', 'foo', 'bar()'), options);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_FUNCTION');
    const shadowed = storageSource('./policy', 'foo', 'bar()').replace(
      'service firebase.storage {',
      'service firebase.storage { function bar() { return true; }',
    );
    expect(resolveModulesBrowser(shadowed, options).success).toBe(true);
  });
});
