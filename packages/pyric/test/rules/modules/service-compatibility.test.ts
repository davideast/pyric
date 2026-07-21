import { describe, test, expect } from 'bun:test';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

const makeSource = (imports: string, body: string = '') => `${imports}
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    ${body}
  }
}`;

const makeStorageSource = (imports: string, condition: string) => `rules_version = '2+modules';
${imports}
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if ${condition}; }
  }
}`;

describe('service-aware module compatibility', () => {
  test('admits every production-probed common auth and membership export in Storage', () => {
    const result = resolveModules(makeStorageSource(
      `import { isAuthenticated, isOwner } from 'auth';
import { hasClaim, hasClaimRole, isMemberOf, hasRole } from 'membership';`,
      "isAuthenticated() && isOwner(request.auth.uid) && hasClaim('plan') && hasClaimRole('role', 'editor') && isMemberOf(request.auth.token.members) && hasRole(request.auth.token.members, 'editor')",
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modules).toEqual(['auth', 'membership']);
      expect(result.data.resolved).toContain("rules_version = '2';");
      expect(result.data.resolved).not.toContain('import ');
      const resolved = parseToAST(result.data.resolved);
      expect(resolved.service.name).toBe('firebase.storage');
      expect(resolved.service.match.functions.map((fn) => fn.name)).toEqual([
        'isAuthenticated',
        'isOwner',
        'hasClaim',
        'hasClaimRole',
        'isMemberOf',
        'hasRole',
      ]);
    }
  });

  test('rejects a Firestore-only stdlib export in Storage before emitting source', () => {
    const result = resolveModules(makeStorageSource(
      "import { immutableFields } from 'lifecycle';",
      "immutableFields(['owner'])",
    ));

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INCOMPATIBLE_FUNCTION',
        message: "Function 'immutableFields' from module 'lifecycle' is not compatible with service 'firebase.storage'",
      },
    });
  });

  test('rejects an incompatible transitive private helper from a caller module', () => {
    const result = resolveModules(
      makeStorageSource("import { allowed } from './policy';", 'allowed()'),
      {
        modules: {
          './policy': `
            function firestoreDocumentOwner() {
              return resource.data.owner;
            }
            export function allowed() {
              return firestoreDocumentOwner() == request.auth.uid;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain('policy__firestoreDocumentOwner');
      expect(result.error.message).toContain("binding 'resource.data");
      expect(result.error.message).toContain("service 'firebase.storage'");
    }
  });

  test('rejects Storage-only ambient object fields from a Firestore caller module', () => {
    const result = resolveModules(
      makeSource("import { uploadIsSmall } from './policy';"),
      {
        modules: {
          './policy': `
            export function uploadIsSmall() {
              return request.resource.size < 1024;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain("binding 'request.resource.size'");
      expect(result.error.message).toContain("service 'cloud.firestore'");
    }
  });

  test('fails closed on an unclassified Storage ambient object field', () => {
    const result = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      {
        modules: {
          './policy': `
            export function hasDigest() {
              return request.resource.md5Hash != null;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain("binding 'request.resource.md5Hash'");
      expect(result.error.message).toContain("service 'firebase.storage'");
    }
  });

  test('rejects Storage bindings that production exposes but the evaluator does not implement', () => {
    for (const expression of [
      'request.resource.name',
      'resource.md5Hash',
      'resource.crc32c',
      'resource.etag',
    ]) {
      const result = resolveModules(
        makeStorageSource("import { readsUnimplemented } from './policy';", 'readsUnimplemented()'),
        { modules: { './policy': `
          export function readsUnimplemented() {
            return ${expression} != null;
          }
        ` } },
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain(`binding '${expression}'`);
    }
  });

  test('does not let literal bracket notation bypass ambient binding checks', () => {
    const storage = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      { modules: { './policy': `
        export function hasDigest() {
          return request.resource['md5Hash'] != null;
        }
      ` } },
    );
    const firestore = resolveModules(
      makeSource("import { uploadIsSmall } from './policy';"),
      { modules: { './policy': `
        export function uploadIsSmall() {
          return request.resource['size'] < 1024;
        }
      ` } },
    );

    expect(storage.success).toBe(false);
    expect(firestore.success).toBe(false);
    if (!storage.success) expect(storage.error.message).toContain("binding 'request.resource.md5Hash'");
    if (!firestore.success) expect(firestore.error.message).toContain("binding 'request.resource.size'");
  });

  test('fails closed on dynamic access to a closed ambient object', () => {
    const result = resolveModules(
      makeStorageSource("import { readsResource } from './policy';", "readsResource('size')"),
      { modules: { './policy': `
        export function readsResource(field) {
          return request.resource[field] != null;
        }
      ` } },
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("binding 'request.resource[...]'");
  });

  test('does not let collection operations bypass closed Storage object fields', () => {
    for (const expression of [
      "request.resource.get('md5Hash', null) != null",
      "'md5Hash' in resource",
      "resource.keys().hasAll(['md5Hash'])",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { readsDigest } from './policy';", 'readsDigest()'),
        { modules: { './policy': `
          export function readsDigest() {
            return ${expression};
          }
        ` } },
      );

      expect(result.success, expression).toBe(false);
    }
  });

  test('does not let aliases or composite receivers launder closed collection access', () => {
    for (const expression of [
      "incoming.get('md5Hash', null) != null",
      "'md5Hash' in (request.resource || {})",
      "[resource][0].keys().hasAll(['md5Hash'])",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { readsDigest } from './policy';", 'readsDigest()'),
        { modules: { './policy': `
          export function readsDigest() {
            let incoming = request.resource;
            return ${expression};
          }
        ` } },
      );

      expect(result.success, expression).toBe(false);
    }
  });

  test('admits map collection operations on open Storage metadata', () => {
    const result = resolveModules(
      makeStorageSource("import { readsMetadata } from './policy';", 'readsMetadata()'),
      { modules: { './policy': `
        export function readsMetadata() {
          return request.resource.metadata.get('owner', '') == request.auth.uid
            && 'owner' in resource.metadata
            && resource.metadata.keys().hasAll(['owner']);
        }
      ` } },
    );
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('rejects accepted method names on incompatible ambient receiver types', () => {
    for (const expression of [
      "request.resource.metadata.matches('x')",
      "request.resource.metadata.split('x').size() > 0",
      'request.resource.size.keys().size() > 0',
      "request.resource.contentType.get('x', null) != null",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${expression}; }` } },
      );
      expect(result.success, expression).toBe(false);
      if (!result.success) expect(result.error.message).toContain('receiver');
    }
  });

  test('does not let composite receivers launder method receiver types', () => {
    for (const expression of [
      "(request.resource.metadata || {}).matches('x')",
      "[request.resource.metadata][0].split('x').size() > 0",
      "{'value': request.resource.size}.value.keys().size() > 0",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${expression}; }` } },
      );
      expect(result.success, expression).toBe(false);
    }
  });

  test('rejects invalid literal and namespace-result method receivers', () => {
    for (const expression of [
      "[1].matches('x')",
      "{'x': 1}.split('x').size() > 0",
      "'text'.keys().hasAll([])",
      "1.matches('x')",
      "true.matches('x')",
      'false.keys().hasAll([])',
      "null.split('x')",
      "'x'.matches('x').keys().hasAll([])",
      "duration.value(1, 's').keys().hasAll([])",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${expression}; }` } },
      );
      expect(result.success, expression).toBe(false);
    }
  });

  test('rejects invalid projected and source-passed method receivers', () => {
    const cases = [
      { parameter: '', call: 'broken()', expression: '[1][0].keys().hasAll([])' },
      { parameter: '', call: 'broken()', expression: "{'x': 1}.x.keys().hasAll([])" },
      { parameter: 'value', call: 'broken(1)', expression: 'value.keys().hasAll([])' },
    ];
    for (const { parameter, call, expression } of cases) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", call),
        { modules: { './policy': `export function broken(${parameter}) { return ${expression}; }` } },
      );
      expect(result.success, expression).toBe(false);
    }
  });

  test('preserves valid receiver types through lets and helper returns', () => {
    const result = resolveModules(
      makeStorageSource("import { valid } from './policy';", 'valid()'),
      { modules: { './policy': `
        function parts(value) {
          return value.split('/');
        }
        export function valid() {
          let direct = request.resource.contentType.split('/');
          return direct.size() == 2 && parts(request.resource.contentType).size() == 2;
        }
      ` } },
    );

    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('admits accepted string methods on known Storage string bindings', () => {
    const result = resolveModules(
      makeStorageSource("import { valid } from './policy';", 'valid()'),
      { modules: { './policy': `
        export function valid() {
          return request.resource.contentType.matches('image/.*')
            && request.resource.metadata.owner.split(':').size() > 0
            && request.resource.metadata.keys().hasAll(['owner']);
        }
      ` } },
    );

    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('does not let a local alias launder an incompatible ambient binding', () => {
    const storage = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      { modules: { './policy': `
        export function hasDigest() {
          let incoming = request.resource;
          return incoming.md5Hash != null;
        }
      ` } },
    );
    const firestore = resolveModules(
      makeSource("import { uploadIsSmall } from './policy';"),
      { modules: { './policy': `
        export function uploadIsSmall() {
          let incoming = request.resource;
          return incoming.size < 1024;
        }
      ` } },
    );

    expect(storage.success).toBe(false);
    expect(firestore.success).toBe(false);
  });

  test('does not let an identity helper launder an incompatible ambient binding', () => {
    const result = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      { modules: { './policy': `
        function identity(value) { return value; }
        export function hasDigest() {
          return identity(request.resource).md5Hash != null;
        }
      ` } },
    );

    expect(result.success).toBe(false);
  });

  test('does not let composite expressions launder incompatible ambient bindings', () => {
    const expressions = [
      '(request.resource || {}).md5Hash',
      '[request.resource][0].md5Hash',
      "{'incoming': request.resource}.incoming.md5Hash",
      '[request.resource][0:1][0].md5Hash',
    ];

    for (const expression of expressions) {
      const result = resolveModules(
        makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
        { modules: { './policy': `
          export function hasDigest() {
            return ${expression} != null;
          }
        ` } },
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('<derived ambient value>');
    }
  });

  test('rejects unknown bare namespaces even when the method name is otherwise allowed', () => {
    const storage = resolveModules(
      makeStorageSource("import { mysteryValue } from './policy';", 'mysteryValue()'),
      { modules: { './policy': "export function mysteryValue() { return mystery.get('x') != null; }" } },
    );
    const firestore = resolveModules(
      makeSource("import { mysteryValue } from './policy';"),
      { modules: { './policy': "export function mysteryValue() { return mystery.get('x') != null; }" } },
    );

    expect(storage.success).toBe(false);
    expect(firestore.success).toBe(false);
    if (!storage.success) expect(storage.error.message).toContain("namespace 'mystery'");
    if (!firestore.success) expect(firestore.error.message).toContain("namespace 'mystery'");
  });

  test('propagates ambient provenance into helper parameters', () => {
    const result = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      { modules: { './policy': `
        function hasMd5(value) { return value.md5Hash != null; }
        export function hasDigest() {
          return hasMd5(request.resource);
        }
      ` } },
    );

    expect(result.success).toBe(false);
  });

  test('finds transitive private calls hidden in slices and rewrites them', () => {
    const result = resolveModules(
      makeStorageSource("import { allowed } from './policy';", 'allowed()'),
      { modules: { './policy': `
        function firestoreOwners() {
          return [resource.data.owner];
        }
        export function allowed() {
          return firestoreOwners()[0:1].size() == 1;
        }
      ` } },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('policy__firestoreOwners');
      expect(result.error.message).toContain("binding 'resource.data.owner'");
    }
  });

  test('finds transitive private calls hidden in interpolated paths', () => {
    const result = resolveModules(
      makeStorageSource("import { allowed } from './policy';", 'allowed()'),
      { modules: { './policy': `
        function firestoreOwner() {
          return resource.data.owner;
        }
        export function allowed() {
          return firestore.exists(/databases/(default)/documents/users/$(firestoreOwner()));
        }
      ` } },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('policy__firestoreOwner');
      expect(result.error.message).toContain("binding 'resource.data.owner'");
    }
  });

  test('admits production-known Firestore methods and namespaces in caller modules', () => {
    const result = resolveModules(
      makeSource(
        "import { validFirestoreApis } from './policy';",
        'function usesValidFirestoreApis() { return validFirestoreApis(); }',
      ),
      { modules: { './policy': `
        export function validFirestoreApis() {
          return 'HELLO'.lower() == 'hello'
            && math.abs(-1) == 1
            && hashing.sha256('hello').size() > 0
            && latlng.value(0, 0).latitude() == 0;
        }
      ` } },
    );

    expect(result.success).toBe(true);
  });

  test('admits production-valid getAfter in a Firestore caller module despite local divergence', () => {
    const result = resolveModules(
      makeSource("import { after } from './policy';", 'function usesAfter() { return after(); }'),
      { modules: { './policy': `
        export function after() {
          return getAfter(/databases/(default)/documents/teams/t1).data.active == true;
        }
      ` } },
    );

    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('does not taint Storage firestore.get results with ambient path interpolation', () => {
    const result = resolveModules(
      makeStorageSource("import { allowed } from './policy';", 'allowed()'),
      { modules: { './policy': `
        function user() {
          return firestore.get(/databases/(default)/documents/users/$(request.auth.uid));
        }
        export function allowed() {
          let direct = firestore.get(
            /databases/(default)/documents/teams/$(request.auth.token.team)
          );
          return direct.data.allowed == true && user().data.allowed == true;
        }
      ` } },
    );

    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  test('does not allow namespace or path receivers to be laundered through modules', () => {
    const cases = [
      { call: 'broken()', module: `
        export function broken() {
          let fs = firestore;
          return fs.get(/databases/(default)/documents/users/a).data.ok == true;
        }
      ` },
      { call: 'broken()', module: `
        function storageNamespace() { return firestore; }
        export function broken() {
          return storageNamespace().get(/databases/(default)/documents/users/a).data.ok == true;
        }
      ` },
      { call: 'broken(path)', module: `
        export function broken(value) { return value.keys().hasAll([]); }
      ` },
    ];
    for (const candidate of cases) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", candidate.call),
        { modules: { './policy': candidate.module } },
      );

      expect(result.success, candidate.module).toBe(false);
    }
  });
  test('enforces receiver types on Storage firestore lookup results', () => {
    for (const expression of [
      "firestore.get(/databases/(default)/documents/users/a).data.matches('x')",
      'firestore.exists(/databases/(default)/documents/users/a).keys().hasAll([])',
      "firestore.get(/databases/(default)/documents/users/a).data.split('x').size() > 0",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${expression}; }` } },
      );

      expect(result.success, expression).toBe(false);
    }
  });
  test('enforces receiver types on direct Firestore lookup results and propagated values', () => {
    const modules = [
      `export function broken() { return get(/databases/$(database)/documents/users/a).data.matches('x'); }`,
      `export function broken() { return exists(/databases/$(database)/documents/users/a).keys().hasAll([]); }`,
      `export function broken() { return getAfter(/databases/$(database)/documents/users/a).data.split('x').size() > 0; }`,
      `function loaded() { return get(/databases/$(database)/documents/users/a); }
       export function broken() { let document = loaded(); return document.data.matches('x'); }`,
      `function misuse(value) { return value.keys().hasAll([]); }
       export function broken() { return misuse(exists(/databases/$(database)/documents/users/a)); }`,
    ];
    for (const source of modules) {
      const result = resolveModules(makeSource("import { broken } from './policy';"), {
        modules: { './policy': source },
      });
      expect(result.success, source).toBe(false);
    }
  });
  test('admits accepted path.bind and rejects production-rejected namespaces', () => {
    const bind = resolveModules(
      makeSource("import { bindPath } from './policy';"),
      { modules: { './policy': 'export function bindPath(path) { return path.bind({}); }' } },
    );
    const rejected = resolveModules(
      makeSource("import { invalidMath } from './policy';"),
      { modules: { './policy': `
        export function invalidMath() {
          return math.isInfinite(1.0) || cast.bool(1);
        }
      ` } },
    );

    expect(bind.success).toBe(true);
    expect(rejected.success).toBe(false);
  });
});
