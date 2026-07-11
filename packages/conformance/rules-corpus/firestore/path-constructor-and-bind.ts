/**
 * ─── Pack 10: path-constructor-and-bind ───────────────────────────────────
 * Targets Item 5.4 — Path wrapper + `path()` constructor + `Path.bind()`.
 * Pre-fix: literal /foo/$(x) returned a plain string, so `is path` was
 * false; `path("...")` threw UnsupportedError; `bind` had no dispatch.
 * Each case here pins one wrapper invariant against prod.
 */
import type { PackRecord } from './types.ts';

export const pack: PackRecord = {
  fm: 'Item 5.4',
  rationale: 'Sim must implement Path wrapper, path() constructor, and Path.bind(). Pre-fix: pathLiteral returned string (so `is path` was false), path() threw UnsupportedError, bind had no dispatch.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // path literal is path
    match /literalIsPathAllow/{id} {
      allow create: if request.auth != null
        && /databases/$(database)/documents/users/alice is path;
    }
    // path() builtin returns Path
    match /constructorIsPathAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') is path;
    }
    // Path equality across two constructions
    match /pathEqAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') == path('users/alice');
    }
    // Path inequality
    match /pathNeqAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice') != path('users/bob');
    }
    // Path is NOT string / NOT map (typeName specificity)
    match /pathSpecificityAllow/{id} {
      allow create: if request.auth != null
        && !(path('a/b') is string)
        && !(path('a/b') is map);
    }
    // Path.bind substitutes placeholder
    match /bindAllow/{id} {
      allow create: if request.auth != null
        && path('users/{uid}').bind({'uid': 'alice'}) == path('users/alice');
    }
    // Path numeric index
    match /pathIndexAllow/{id} {
      allow create: if request.auth != null
        && path('users/alice')[1] == 'alice';
    }
    // path() idempotent on Path arg
    match /pathIdempotentAllow/{id} {
      allow create: if request.auth != null
        && path(path('users/alice')) == path('users/alice');
    }
    // DENY witness — wrong path equality
    match /wrongPathDeny/{id} {
      allow create: if request.auth != null
        && path('users/alice') == path('users/bob');
    }
  }
}`,
  cases: [
    {
      description: 'literal /foo/$(db)/... is path ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'literalIsPathAllow/d1',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: "path('users/alice') is path ALLOW",
      expectation: 'ALLOW',
      method: 'create',
      path: 'constructorIsPathAllow/d2',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path equality ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathEqAllow/d3',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path inequality ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathNeqAllow/d4',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path is not string / not map ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathSpecificityAllow/d5',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'Path.bind substitutes placeholder ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'bindAllow/d6',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'Path[1] returns segment ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathIndexAllow/d7',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'path() idempotent on Path arg ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'pathIdempotentAllow/d8',
      auth: { uid: 'alice' },
      data: {},
    },
    {
      description: 'wrong path equality DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'wrongPathDeny/d9',
      auth: { uid: 'alice' },
      data: {},
    },
  ],
  group: 'stress',
};
