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

  test('rejects unresolved nested receivers projected from a map parameter', () => {
    for (const expression of [
      "value.nested.flag.matches('x')",
      "value['nested']['flag'].matches('x')",
    ]) {
      const result = resolveModules(`rules_version = '2+modules';
import { broken } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} { allow read: if broken({'nested': {'flag': true}}); }
  }
}`, { modules: { './policy': `export function broken(value) { return ${expression}; }` } });
      expect(result.success, expression).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
    }
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

  test('preserves Map.keys return types through source helpers', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { required } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    function metadataKeys() { return request.resource.metadata.keys(); }
    match /{file} { allow write: if required(metadataKeys()); }
  }
}`, { modules: {
      './policy': "export function required(keys) { return keys.hasAll(['owner']); }",
    } });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('preserves receiver types projected from source literals', () => {
    for (const projection of [
      "{'nested': {'owner': true}}.nested",
      "[{'owner': true}][0]",
    ]) {
      const result = resolveModules(`rules_version = '2+modules';
import { required } from './policy';
service firebase.storage {
  function projected() { return ${projection}; }
  match /b/{bucket}/o { match /{file} { allow read: if required(projected()); } }
}`, { modules: {
        './policy': "export function required(value) { return value.keys().hasAll(['owner']); }",
      } });
      expect(result.success, result.success ? undefined : `${projection}: ${result.error.message}`).toBe(true);
    }
  });

  test('preserves wildcard receiver types inside match-scoped helpers', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { validName } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    match /images/{file} {
      function gate() { return validName(file); }
      allow read: if gate();
    }
  }
}`, { modules: {
      './policy': "export function validName(value) { return value.matches('.*'); }",
    } });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('preserves ambient provenance through source helpers and lets', () => {
    const result = resolveModules(`rules_version = '2+modules';
import { bad } from './policy';
service firebase.storage {
  match /b/{bucket}/o {
    function value() { return request.resource; }
    function gate() { let incoming = value(); return bad(incoming); }
    match /{file} { allow write: if gate(); }
  }
}`, { modules: { './policy': 'export function bad(value) { return value.md5Hash != null; }' } });
    expect(result.success).toBe(false);
  });

  test('does not let source composites launder ambient provenance', () => {
    for (const argument of [
      '[resource]',
      "{'value': resource}",
      '[resource][0:1]',
      'resource == null ? [resource] : [resource]',
    ]) {
      const result = resolveModules(`rules_version = '2+modules';
import { bad } from './policy';
service firebase.storage {
  match /b/{bucket}/o { match /{file} { allow write: if bad(${argument}); } }
}`, { modules: { './policy': "export function bad(value) { return value[0].data.owner == 'alice'; }" } });
      expect(result.success, argument).toBe(false);
    }
  });

  test('does not taint Firestore lookup results with ambient path interpolation', () => {
    for (const sourceExpression of [
      'firestore.get(/databases/(default)/documents/members/$(request.auth.uid)).data',
      'membershipDoc(request.auth.uid)',
    ]) {
      const helper = sourceExpression.startsWith('membershipDoc')
        ? 'function membershipDoc(uid) { return firestore.get(/databases/(default)/documents/members/$(uid)).data; }'
        : '';
      const result = resolveModules(`rules_version = '2+modules';
import { hasRole } from 'membership';
service firebase.storage {
  match /b/{bucket}/o {
    ${helper}
    match /{file} { allow read: if hasRole(${sourceExpression}, 'editor'); }
  }
}`);
      expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    }
  });
});
