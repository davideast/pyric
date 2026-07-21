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


