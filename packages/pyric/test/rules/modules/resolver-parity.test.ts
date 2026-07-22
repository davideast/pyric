import { describe, expect, test } from 'bun:test';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

function storageSource(moduleName: string, functionName: string): string {
  return `rules_version = '2+modules';
import { ${functionName} } from '${moduleName}';
service firebase.storage {
  match /b/{bucket}/o { match /{path=**} {
    allow read: if ${functionName}();
  } }
}`;
}

describe('Node/browser module resolver parity', () => {
  test.each([
    ['built-in key', 'auth', 'isAuthenticated', undefined],
    ['conventional path alias', './stdlib/auth.rules', 'isAuthenticated', undefined],
    ['caller override', 'auth', 'callerPolicy', {
      modules: { auth: 'export function callerPolicy() { return true; }' },
    }],
    ['caller path-alias override', './stdlib/auth.rules', 'callerPolicy', {
      modules: {
        './stdlib/auth.rules': 'export function callerPolicy() { return true; }',
      },
    }],
  ] as const)('%s', (_description, moduleName, functionName, options) => {
    const source = storageSource(moduleName, functionName);
    const node = resolveModules(source, options);
    const browser = resolveModulesBrowser(source, options);
    expect(node, node.success ? undefined : node.error.message).toEqual(browser);
  });
});
