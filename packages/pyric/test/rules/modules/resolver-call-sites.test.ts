import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { moduleCallSites } from '../../../src/rules/modules/resolver-call-sites.js';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

describe('resolver source call sites', () => {
  test('types single and recursive match captures as string and path', () => {
    const ast = parseToAST(`rules_version = '2+modules';
import { policy } from './policy';
service cloud.firestore {
  match /databases/{database}/documents/{tail=**} {
    match /users/{uid} { allow read: if policy(uid, tail); }
  }
}`);
    if (!ast) throw new Error('fixture failed to parse');
    expect(moduleCallSites(ast, 'policy').map(({ receiverTypes }) => receiverTypes)).toEqual([
      ['string', 'path'],
    ]);
  });

  test('rejects Path methods on a Firestore single-segment wildcard', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { broken } from './policy';
service cloud.firestore {
  match /databases/{database}/documents/users/{uid} {
    allow read: if broken(uid);
  }
}`, { modules: { './policy': 'export function broken(value) { return value.bind({}); }' } });
    expect(result.success).toBe(false);
  });

  test('admits String methods on a Storage single-segment wildcard', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { validName } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    match /images/{file} { allow read: if validName(file); }
  }
}`, { modules: { './policy': "export function validName(value) { return value.matches('.*[.]png'); }" } });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('rejects a wrong receiver hidden behind a source helper let', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { check } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    function gate() { let n = 1; return check(n); }
    match /{file} { allow read: if gate(); }
  }
}`, { modules: { './policy': "export function check(value) { return value.matches('x'); }" } });
    expect(result.success).toBe(false);
  });

  test('preserves a valid receiver through source parameters, lets, and helper returns', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { check } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    function identity(value) { return value; }
    function gate(value) { let name = identity(value); return check(name); }
    match /{file} { allow read: if gate(file); }
  }
}`, { modules: { './policy': "export function check(value) { return value.matches('.*'); }" } });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });
});
