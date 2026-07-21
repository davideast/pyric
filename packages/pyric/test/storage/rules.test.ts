/**
 * Slice 8 — Storage rules.
 *
 * Split into two sections:
 *   1. Parser + evaluator unit tests (paths, expressions, wildcards)
 *   2. Operation integration (uploadBytes / getBlob / deleteObject
 *      / getMetadata / updateMetadata gate on configured rules)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  getBlob,
  deleteObject,
  getMetadata,
  updateMetadata,
  parseStorageRules,
  evaluateStorageRules,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const SESSION_ARCHIVE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.method == 'delete'
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

// Owner-scoped ruleset exercising `resource.metadata.*` (existing
// object's custom metadata) on reads and `request.resource.metadata.*`
// (about-to-write custom metadata) on writes. Regression cover for
// #764 — before the fix both bindings read `undefined` and the
// authorization comparisons failed open.
const METADATA_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read: if resource.metadata.owner == request.auth.uid;
      allow write: if request.resource.metadata.owner == request.auth.uid;
    }
  }
}`;

// ─── Parser + evaluator unit tests ────────────────────────────────

describe('parseStorageRules', () => {
  it('parses the canonical session-archive ruleset', () => {
    const rules = parseStorageRules(SESSION_ARCHIVE_RULES);
    expect(rules).toBeDefined();
  });

  it('rejects unknown service header', () => {
    expect(() =>
      parseStorageRules(`service cloud.firestore { match /x { allow read: if true; } }`),
    ).toThrow();
  });

  it('parses the granular verbs (get/list/create/update/delete)', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x/{id} { allow get, list, create, update, delete: if true; }
        }
      }`),
    ).not.toThrow();
  });

  it('rejects verbs outside the storage grammar', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x/{id} { allow query: if true; }
        }
      }`),
    ).toThrow(/expected "delete", "update", "create", "list", "get", "write", or "read"/);
  });

  it('rejects unterminated strings', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x { allow read: if 'unterminated; }
        }
      }`),
    ).toThrow();
  });
});

describe('evaluateStorageRules', () => {
  const rules = parseStorageRules(SESSION_ARCHIVE_RULES);

  it('allows authenticated reads of /sessions/{id}', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/sessions/s1.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(true);
  });

  it('denies anonymous reads', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: null, method: 'read', path: 'b/pyric-default/o/sessions/s1.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(false);
  });

  it('allows JSON writes under 10MB', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 1024, contentType: 'application/json' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('denies writes that exceed the size limit', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 11 * 1024 * 1024, contentType: 'application/json' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies writes with the wrong contentType', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path: 'b/pyric-default/o/sessions/s1.json',
        resource: { size: 1024, contentType: 'text/plain' },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies paths that do not match any block', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/other/x.json' },
      resource: { size: 12 },
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('supports the {allPaths=**} wildcard', () => {
    const wild = parseStorageRules(`
      service firebase.storage {
        match /b/{bucket}/o {
          match /{allPaths=**} {
            allow read, write: if request.auth != null;
          }
        }
      }`);
    const r = evaluateStorageRules(wild, {
      request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/anything/at/depth.json' },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('honors token claims in conditions', () => {
    const admin = parseStorageRules(`
      service firebase.storage {
        match /b/{bucket}/o {
          match /admin/{id} {
            allow read: if request.auth.token['role'] == 'admin';
          }
        }
      }`);
    expect(
      evaluateStorageRules(admin, {
        request: { auth: { uid: 'a', token: { role: 'admin' } }, method: 'read', path: 'b/pyric-default/o/admin/secret.json' },
        resource: null,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(admin, {
        request: { auth: { uid: 'a', token: { role: 'viewer' } }, method: 'read', path: 'b/pyric-default/o/admin/secret.json' },
        resource: null,
      }).allowed,
    ).toBe(false);
  });
});

describe('evaluateStorageRules — metadata bindings (#764)', () => {
  const rules = parseStorageRules(METADATA_RULES);
  const path = 'b/pyric-default/o/docs/d1.json';

  it('allows a read when resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a read when resource.metadata.owner is a different user', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'bob' }, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous read against resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: { auth: null, method: 'read', path },
      resource: { size: 12, metadata: { owner: 'alice' } },
    });
    expect(r.allowed).toBe(false);
  });

  it('allows a write when request.resource.metadata.owner matches request.auth.uid', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('denies a write claiming another user in request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'bob' },
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });

  it('denies an anonymous write against request.resource.metadata.owner', () => {
    const r = evaluateStorageRules(rules, {
      request: {
        auth: null,
        method: 'write',
        path,
        resource: { size: 2, contentType: 'application/json', metadata: { owner: 'alice' } },
      },
      resource: null,
    });
    expect(r.allowed).toBe(false);
  });
});

// ─── Custom metadata: dotted AND bracket access ──────────────────
//
// Custom metadata is a flat string→string map. Both `resource.metadata.owner`
// (dotted) and `resource.metadata['owner']` (bracket) must resolve to the
// same value; a missing key resolves to undefined and denies (never a false
// allow).

describe('evaluateStorageRules — custom metadata access forms', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalRead(cond: string, metadata: Record<string, string>, uid: string): boolean {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid }, method: 'read', path },
      resource: { size: 3, metadata },
    }).allowed;
  }

  it('resolves dotted metadata access', () => {
    expect(evalRead("resource.metadata.owner == request.auth.uid", { owner: 'alice' }, 'alice')).toBe(true);
  });

  it('resolves bracket metadata access identically to dotted', () => {
    expect(evalRead("resource.metadata['owner'] == request.auth.uid", { owner: 'alice' }, 'alice')).toBe(true);
  });

  it('denies when the metadata key is absent (undefined, never a false allow)', () => {
    expect(evalRead("resource.metadata.owner == request.auth.uid", { other: 'alice' }, 'alice')).toBe(false);
    expect(evalRead("resource.metadata['owner'] == request.auth.uid", { other: 'alice' }, 'alice')).toBe(false);
  });

  it('supports required metadata keys through keys().hasAll()', () => {
    expect(
      evalRead(
        "resource.metadata.keys().hasAll(['owner', 'purpose'])",
        { owner: 'alice', purpose: 'avatar', extra: 'allowed' },
        'alice',
      ),
    ).toBe(true);
  });

  it('supports a default for an absent metadata key through Map.get()', () => {
    expect(
      evalRead(
        "resource.metadata.get('visibility', 'private') == 'private'",
        { owner: 'alice' },
        'alice',
      ),
    ).toBe(true);
  });

  it('does not treat boxed float values as maps or sized collections', () => {
    expect(evalRead("1.0.get('value', 0) == 1", {}, 'alice')).toBe(false);
    expect(evalRead("1.0.keys().hasAll(['value'])", {}, 'alice')).toBe(false);
    expect(evalRead('1.0.size() == 1', {}, 'alice')).toBe(false);
    expect(evalRead('1.0 is map', {}, 'alice')).toBe(false);
    expect(evalRead("'value' in 1.0", {}, 'alice')).toBe(false);
    expect(evalRead('1.0.value == 1', {}, 'alice')).toBe(false);
    expect(evalRead("1.0['value'] == 1", {}, 'alice')).toBe(false);
  });
});

// ─── request.time + timestamp constructors ───────────────────────
//
// `request.time` is the request's evaluation moment. Rules compare it
// against `timestamp.date(y,m,d)` (UTC midnight) and
// `timestamp.value(epochMillis)`. The caller injects the time (3rd arg);
// it defaults to now at evaluation.

describe('evaluateStorageRules — request.time', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalTime(cond: string, now: Date): boolean {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(
      rules,
      { request: { auth: { uid: 'alice' }, method: 'read', path }, resource: { size: 1 } },
      now,
    ).allowed;
  }

  it('allows when request.time is before timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2026-07-10T00:00:00Z'))).toBe(true);
  });

  it('denies when request.time is after timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2031-01-01T00:00:00Z'))).toBe(false);
  });

  it('compares request.time against timestamp.value(epochMillis)', () => {
    const cutoff = Date.UTC(2028, 0, 1);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff - 1000))).toBe(true);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff + 1000))).toBe(false);
  });

  it('defaults request.time to now when the caller omits it', () => {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if request.time < timestamp.date(2100, 1, 1); }
      }
    }`);
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1 },
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── string.matches() regex ──────────────────────────────────────
//
// `string.matches(re)` — RE2-style pattern that must match the WHOLE
// string (production anchors implicitly). Invalid patterns and known
// RE2-unsupported constructs deny with a reason, never a false allow.

describe('evaluateStorageRules — matches()', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalMatch(cond: string, metadata: Record<string, string>): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1, metadata },
    });
  }

  it('matches a whole-string pattern', () => {
    expect(evalMatch("resource.metadata.kind.matches('[a-z]+')", { kind: 'report' }).allowed).toBe(true);
  });

  it('is whole-string anchored: partial pattern does NOT match', () => {
    // 'abc'.matches('a') is FALSE — production anchors implicitly.
    expect(evalMatch("resource.metadata.kind.matches('a')", { kind: 'abc' }).allowed).toBe(false);
  });

  it('denies (with reason) on an invalid regex pattern', () => {
    const r = evalMatch("resource.metadata.kind.matches('[')", { kind: 'abc' });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('matches');
  });

  it('denies a backreference pattern (RE2-unsupported, would fail in production)', () => {
    const r = evalMatch("resource.metadata.kind.matches('(a)\\\\1')", { kind: 'aa' });
    expect(r.allowed).toBe(false);
  });

  it('denies a lookahead pattern (RE2-unsupported, would fail in production)', () => {
    const r = evalMatch("resource.metadata.kind.matches('a(?=b)')", { kind: 'ab' });
    expect(r.allowed).toBe(false);
  });

  it('denies matches() against a non-string target', () => {
    const r = evalMatch("resource.metadata.missing.matches('.*')", { kind: 'abc' });
    expect(r.allowed).toBe(false);
  });
});

// ─── firestore.get() / firestore.exists() cross-service lookups ───
//
// Storage rules may read Firestore documents to authorize an op:
//
//   firestore.get(/databases/(default)/documents/users/$(request.auth.uid))
//     .data.premium == true
//
// The evaluator stays PURE — it never imports the Firestore sandbox.
// A lookup capability is injected (4th arg). Path syntax:
// `/databases/<db>/documents/<collection>/<doc>` with `$(expr)`
// interpolation segments; the `/databases/<db>/documents/` prefix is
// stripped and the remaining document path is handed to the lookup
// (matching `sandbox.admin.getDocument`'s `collection/doc` form).
//
// Failure posture is deny-with-reason (never a false allow):
//   - no lookup injected             → deny "unsupported"
//   - get() on a nonexistent doc     → deny (production errors, errors deny)
//   - malformed path / wrong arg type → deny
describe('evaluateStorageRules — firestore.get / firestore.exists', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalFs(
    cond: string,
    docs: Record<string, Record<string, unknown>>,
    auth: { uid: string } | null = { uid: 'alice' },
  ): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    const lookup = {
      get(p: string) {
        return p in docs ? docs[p] : null;
      },
      exists(p: string) {
        return p in docs;
      },
    };
    return evaluateStorageRules(
      rules,
      { request: { auth, method: 'read', path }, resource: { size: 1 } },
      undefined,
      lookup,
    );
  }

  it('allows when an interpolated firestore.get reads .data.premium == true', () => {
    const r = evalFs(
      'firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true',
      { 'users/alice': { premium: true } },
    );
    expect(r.allowed).toBe(true);
  });

  it('denies when the looked-up field is false', () => {
    const r = evalFs(
      'firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true',
      { 'users/alice': { premium: false } },
    );
    expect(r.allowed).toBe(false);
  });

  it('firestore.exists returns true for a present document', () => {
    const r = evalFs(
      'firestore.exists(/databases/(default)/documents/members/$(request.auth.uid))',
      { 'members/alice': { since: 1 } },
    );
    expect(r.allowed).toBe(true);
  });

  it('firestore.exists returns false for an absent document', () => {
    const r = evalFs(
      'firestore.exists(/databases/(default)/documents/members/$(request.auth.uid))',
      {},
    );
    expect(r.allowed).toBe(false);
  });

  it('denies (with reason) when firestore.get targets a nonexistent doc', () => {
    // Production: get() on a missing doc is an error, and errors deny.
    const r = evalFs(
      'firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true',
      {},
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/firestore\.get|nonexistent|does not exist/i);
  });

  it('denies "unsupported" when NO lookup capability is injected', () => {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} {
          allow read: if firestore.exists(/databases/(default)/documents/users/$(request.auth.uid));
        }
      }
    }`);
    // No 4th arg — pure/test usage with no sandbox.
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1 },
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/unsupported|firestore/i);
  });

  it('denies on a malformed path (missing /databases/<db>/documents prefix)', () => {
    const r = evalFs('firestore.exists(/users/$(request.auth.uid))', {
      'users/alice': { x: 1 },
    });
    expect(r.allowed).toBe(false);
  });

  it('denies when an interpolation segment resolves to a non-string (auth is null)', () => {
    const r = evalFs(
      'firestore.exists(/databases/(default)/documents/users/$(request.auth.uid))',
      { 'users/alice': { x: 1 } },
      null,
    );
    expect(r.allowed).toBe(false);
  });

  it('treats anonymous request.auth in a ternary condition as an error', () => {
    const r = evalFs(
      'request.auth != null'
        + ' ? firestore.exists(/databases/(default)/documents/members/alice)'
        + ' : firestore.exists(/databases/(default)/documents/members/anonymous)',
      { 'members/anonymous': { active: true } },
      null,
    );

    expect(r.allowed).toBe(false);
  });

  it('denies a third distinct Firestore document access', () => {
    const r = evalFs(
      'firestore.exists(/databases/(default)/documents/members/a)'
        + ' && firestore.exists(/databases/(default)/documents/members/b)'
        + ' && firestore.exists(/databases/(default)/documents/members/c)',
      {
        'members/a': { active: true },
        'members/b': { active: true },
        'members/c': { active: true },
      },
    );

    expect(r.allowed).toBe(false);
  });

  it('does not charge repeated access to the same Firestore document more than once', () => {
    const same = 'firestore.exists(/databases/(default)/documents/members/a)';
    expect(evalFs(`${same} && ${same} && ${same}`, { 'members/a': { active: true } }).allowed).toBe(true);
  });

  it('denies a lookup into a named Firestore database', () => {
    expect(
      evalFs(
        'firestore.exists(/databases/probes/documents/members/alice)',
        { 'members/alice': { active: true } },
      ).allowed,
    ).toBe(false);
  });
});

// ─── Granular verbs (get/list/create/update/delete) ──────────────
//
// Production Storage semantics:
//   - `read`  is the umbrella for `get` + `list`.
//   - `write` is the umbrella for `create` + `update` + `delete`.
//   - A granular grant covers ONLY its own verb.
//   - Deny-by-default: a verb with no applicable grant is denied.

describe('evaluateStorageRules — granular verbs', () => {
  const path = 'b/pyric-default/o/files/f1.bin';

  function evalVerb(source: string, method: string) {
    const rules = parseStorageRules(source);
    return evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: method as never, path },
      resource: null,
    }).allowed;
  }

  function ruleset(allow: string): string {
    return `service firebase.storage {
      match /b/{bucket}/o {
        match /files/{fileId} { ${allow} }
      }
    }`;
  }

  it('read is an umbrella granting both get and list', () => {
    const src = ruleset('allow read: if true;');
    expect(evalVerb(src, 'get')).toBe(true);
    expect(evalVerb(src, 'list')).toBe(true);
  });

  it('write is an umbrella granting create, update, and delete', () => {
    const src = ruleset('allow write: if true;');
    expect(evalVerb(src, 'create')).toBe(true);
    expect(evalVerb(src, 'update')).toBe(true);
    expect(evalVerb(src, 'delete')).toBe(true);
  });

  it('allow get grants get but NOT list', () => {
    const src = ruleset('allow get: if true;');
    expect(evalVerb(src, 'get')).toBe(true);
    expect(evalVerb(src, 'list')).toBe(false);
  });

  it('allow list grants list but NOT get', () => {
    const src = ruleset('allow list: if true;');
    expect(evalVerb(src, 'list')).toBe(true);
    expect(evalVerb(src, 'get')).toBe(false);
  });

  it('allow create grants create but NOT update or delete', () => {
    const src = ruleset('allow create: if true;');
    expect(evalVerb(src, 'create')).toBe(true);
    expect(evalVerb(src, 'update')).toBe(false);
    expect(evalVerb(src, 'delete')).toBe(false);
  });

  it('allow update grants update but NOT create or delete', () => {
    const src = ruleset('allow update: if true;');
    expect(evalVerb(src, 'update')).toBe(true);
    expect(evalVerb(src, 'create')).toBe(false);
    expect(evalVerb(src, 'delete')).toBe(false);
  });

  it('allow delete grants delete but NOT create or update', () => {
    const src = ruleset('allow delete: if true;');
    expect(evalVerb(src, 'delete')).toBe(true);
    expect(evalVerb(src, 'create')).toBe(false);
    expect(evalVerb(src, 'update')).toBe(false);
  });

  it('parses and honors a comma-separated verb list (allow get, list)', () => {
    const src = ruleset('allow get, list: if true;');
    expect(evalVerb(src, 'get')).toBe(true);
    expect(evalVerb(src, 'list')).toBe(true);
    expect(evalVerb(src, 'create')).toBe(false);
  });

  it('mixes granular grants: create allowed, update/delete denied', () => {
    const src = ruleset('allow create: if request.auth != null; allow get: if true;');
    expect(evalVerb(src, 'create')).toBe(true);
    expect(evalVerb(src, 'get')).toBe(true);
    expect(evalVerb(src, 'update')).toBe(false);
    expect(evalVerb(src, 'delete')).toBe(false);
    expect(evalVerb(src, 'list')).toBe(false);
  });

  it('deny-by-default: a verb with no applicable grant is denied', () => {
    const src = ruleset('allow get: if true;');
    const rules = parseStorageRules(src);
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'delete' as never, path },
      resource: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
    // The reason names the verb that was actually evaluated.
    expect(r.reasons.join(' ')).toContain('delete');
  });

  it('create-vs-update discriminates on object existence (nonexistent → create)', () => {
    // Grant only create; the create verb (nonexistent object) is allowed,
    // the update verb (existing object) is denied — the caller supplies
    // the verb based on the resource-exists fact.
    const src = ruleset('allow create: if true;');
    // create: request.resource present, resource (existing) null
    const rules = parseStorageRules(src);
    const asCreate = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'create' as never, path, resource: { size: 1 } },
      resource: null,
    });
    const asUpdate = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'update' as never, path, resource: { size: 1 } },
      resource: { size: 1 },
    });
    expect(asCreate.allowed).toBe(true);
    expect(asUpdate.allowed).toBe(false);
  });

  it('treats a missing existing resource on create as an error, matching production', () => {
    const rules = parseStorageRules(ruleset('allow create: if resource == null;'));
    const result = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'create',
        path,
        resource: { size: 1 },
      },
      resource: null,
    });

    expect(result.allowed).toBe(false);
  });

  it('treats a missing incoming resource on delete as an error, matching production', () => {
    const rules = parseStorageRules(ruleset('allow delete: if request.resource == null;'));
    const result = evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'alice' },
        method: 'delete',
        path,
      },
      resource: { size: 1 },
    });

    expect(result.allowed).toBe(false);
  });
});

// ─── User-defined functions ───────────────────────────────────────
//
// Production Storage rules (rules_version '2') support `function`
// declarations at service scope and inside match blocks. They are
// lexically scoped (visible within their declaring block and nested
// blocks), may take arguments, may contain `let` bindings before a
// single `return`, and may call other functions. Any function-eval
// failure (undefined, wrong arity, depth exceeded, error in body)
// must DENY with a reason that names the function — never a false
// allow.

describe('evaluateStorageRules — user-defined functions', () => {
  const path = 'b/pyric-default/o/files/f1.bin';

  function evalRule(source: string, opts: {
    method?: string;
    auth?: { uid: string; token?: Record<string, unknown> } | null;
    reqPath?: string;
    resource?: StorageResourceLike;
  } = {}) {
    const rules = parseStorageRules(source);
    return evaluateStorageRules(rules, {
      request: {
        auth: opts.auth === undefined ? { uid: 'alice' } : opts.auth,
        method: (opts.method ?? 'read') as never,
        path: opts.reqPath ?? path,
      },
      resource: opts.resource ?? null,
    });
  }

  it('declares a function at service scope and calls it from an allow', () => {
    const src = `service firebase.storage {
      function signedIn() { return request.auth != null; }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if signedIn(); }
      }
    }`;
    expect(evalRule(src, { auth: { uid: 'alice' } }).allowed).toBe(true);
    expect(evalRule(src, { auth: null }).allowed).toBe(false);
  });

  it('declares a function inside a match block', () => {
    const src = `service firebase.storage {
      match /b/{bucket}/o {
        match /files/{fileId} {
          function signedIn() { return request.auth != null; }
          allow read: if signedIn();
        }
      }
    }`;
    expect(evalRule(src, { auth: { uid: 'alice' } }).allowed).toBe(true);
    expect(evalRule(src, { auth: null }).allowed).toBe(false);
  });

  it('evaluates arguments in the caller context and binds them to params', () => {
    // isOwner(userId) compares its parameter to the auth uid; the
    // caller passes the path wildcard fileId as the arg.
    const src = `service firebase.storage {
      function isOwner(userId) {
        return request.auth != null && request.auth.uid == userId;
      }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if isOwner(fileId); }
      }
    }`;
    // path param fileId === 'alice' → owner match
    expect(
      evalRule(src, { auth: { uid: 'alice' }, reqPath: 'b/pyric-default/o/files/alice' }).allowed,
    ).toBe(true);
    expect(
      evalRule(src, { auth: { uid: 'bob' }, reqPath: 'b/pyric-default/o/files/alice' }).allowed,
    ).toBe(false);
  });

  it('does not leak caller wildcards into the body except via args', () => {
    // The body references `fileId` directly, but a function body does
    // NOT see the caller's path wildcards (only its own params). The
    // reference resolves to undefined → falsy → deny.
    const src = `service firebase.storage {
      function leaks() { return fileId == 'alice'; }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if leaks(); }
      }
    }`;
    expect(
      evalRule(src, { auth: { uid: 'alice' }, reqPath: 'b/pyric-default/o/files/alice' }).allowed,
    ).toBe(false);
  });

  it('inner declaration shadows an outer one of the same name', () => {
    const src = `service firebase.storage {
      function which() { return false; }
      match /b/{bucket}/o {
        match /files/{fileId} {
          function which() { return true; }
          allow read: if which();
        }
      }
    }`;
    expect(evalRule(src, { auth: { uid: 'alice' } }).allowed).toBe(true);
  });

  it('a function is not visible outside its declaring block', () => {
    // `scoped` is declared inside /files; the sibling /public block
    // cannot call it → undefined function → deny with reason.
    const src = `service firebase.storage {
      match /b/{bucket}/o {
        match /files/{fileId} {
          function scoped() { return true; }
          allow read: if true;
        }
        match /public/{id} { allow read: if scoped(); }
      }
    }`;
    const r = evalRule(src, { auth: { uid: 'alice' }, reqPath: 'b/pyric-default/o/public/x' });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('scoped');
  });

  it('supports a function calling another function', () => {
    const src = `service firebase.storage {
      function signedIn() { return request.auth != null; }
      function isOwner(userId) { return signedIn() && request.auth.uid == userId; }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if isOwner(fileId); }
      }
    }`;
    expect(
      evalRule(src, { auth: { uid: 'alice' }, reqPath: 'b/pyric-default/o/files/alice' }).allowed,
    ).toBe(true);
    expect(
      evalRule(src, { auth: null, reqPath: 'b/pyric-default/o/files/alice' }).allowed,
    ).toBe(false);
  });

  it('supports let bindings before the return', () => {
    const src = `service firebase.storage {
      function bigEnough() {
        let limit = 10 * 1024;
        let ok = request.resource.size < limit;
        return ok;
      }
      match /b/{bucket}/o {
        match /files/{fileId} { allow write: if bigEnough(); }
      }
    }`;
    const rules = parseStorageRules(src);
    expect(
      evaluateStorageRules(rules, {
        request: { auth: { uid: 'a' }, method: 'write' as never, path, resource: { size: 5 } },
        resource: null,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(rules, {
        request: { auth: { uid: 'a' }, method: 'write' as never, path, resource: { size: 20 * 1024 } },
        resource: null,
      }).allowed,
    ).toBe(false);
  });

  it('undefined function → deny with reason naming the function', () => {
    const src = `service firebase.storage {
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if missing(); }
      }
    }`;
    const r = evalRule(src, { auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('missing');
  });

  it('arity mismatch → deny with reason naming the function', () => {
    const src = `service firebase.storage {
      function isOwner(userId) { return request.auth.uid == userId; }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if isOwner(); }
      }
    }`;
    const r = evalRule(src, { auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('isOwner');
  });

  it('recursion depth cap → deny with reason (never loops)', () => {
    const src = `service firebase.storage {
      function loop() { return loop(); }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if loop(); }
      }
    }`;
    const r = evalRule(src, { auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('loop');
  });

  it('an error inside a function body denies rather than false-allows', () => {
    // The body calls a function that is undefined; the error propagates
    // out of the nested call and denies.
    const src = `service firebase.storage {
      function outer() { return inner(); }
      match /b/{bucket}/o {
        match /files/{fileId} { allow read: if outer(); }
      }
    }`;
    const r = evalRule(src, { auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('inner');
  });
});

// Local structural alias so the helper above stays readable.
type StorageResourceLike = { size: number; contentType?: string; metadata?: Record<string, string> } | null;

// ─── Operation integration tests ──────────────────────────────────

function authedStorage(label: string, auth: { uid: string } | null) {
  const sandbox = initializeSandbox({});
  const ctx = sandbox.withAuth(auth);
  return getStorageSandbox(ctx, {
    dbName: uniqueDbName(label),
    rules: SESSION_ARCHIVE_RULES,
  });
}

describe('uploadBytes with rules', () => {
  it('rejects a Firestore-only module during Storage setup', () => {
    const sandbox = initializeSandbox({});
    expect(() => getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('modules-incompatible'),
      rules: `rules_version = '2+modules';
import { immutableFields } from 'lifecycle';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow create: if immutableFields(['owner']);
    }
  }
}`,
    })).toThrow(/INCOMPATIBLE_FUNCTION.*immutableFields.*firebase\.storage/);
  });

  it('resolves a checked auth module before enforcing Storage rules', async () => {
    const moduleRules = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow create: if isAuthenticated();
    }
  }
}`;
    const authedSandbox = initializeSandbox({});
    const authed = getStorageSandbox(authedSandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('modules-auth-allow'),
      rules: moduleRules,
    });
    await expect(
      uploadBytes(ref(authed, 'uploads/a.txt'), new Blob(['ok'])),
    ).resolves.toBeDefined();

    const anonSandbox = initializeSandbox({});
    const anon = getStorageSandbox(anonSandbox.withAuth(null), {
      dbName: uniqueDbName('modules-auth-deny'),
      rules: moduleRules,
    });
    await expect(
      uploadBytes(ref(anon, 'uploads/a.txt'), new Blob(['no'])),
    ).rejects.toThrow(/unauthorized/);
  });

  it('maps ordinary SDK object paths into the canonical bucket rules namespace', async () => {
    const storage = authedStorage('upload-canonical-path', { uid: 'alice' });
    const ordinaryRef = ref(storage, 'sessions/s1.json');

    const result = await uploadBytes(ordinaryRef, new Blob(['{}']), {
      contentType: 'application/json',
    });

    expect(result.metadata.fullPath).toBe('sessions/s1.json');
  });

  it('allows an authed JSON upload to /sessions', async () => {
    const storage = authedStorage('upload-allowed', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.json');
    const result = await uploadBytes(r, new Blob(['{}']), {
      contentType: 'application/json',
    });
    expect(result.metadata.fullPath).toBe('sessions/s1.json');
  });

  it('denies an anonymous upload', async () => {
    const storage = authedStorage('upload-anon', null);
    const r = ref(storage, 'sessions/s1.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies non-JSON content type', async () => {
    const storage = authedStorage('upload-bad-ct', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.txt');
    await expect(
      uploadBytes(r, new Blob(['plain']), { contentType: 'text/plain' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a path outside /sessions', async () => {
    const storage = authedStorage('upload-bad-path', { uid: 'alice' });
    const r = ref(storage, 'other/x.json');
    await expect(
      uploadBytes(r, new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe('reads with rules', () => {
  it('allows authed reads', async () => {
    const storage = authedStorage('read-allowed', { uid: 'alice' });
    const r = ref(storage, 'sessions/s1.json');
    await uploadBytes(r, new Blob(['{"s":1}']), { contentType: 'application/json' });
    const blob = await getBlob(r);
    expect(await blob.text()).toBe('{"s":1}');
  });

  it('denies anonymous reads', async () => {
    // Need to seed under an authed context so the file exists, then
    // re-read anonymously.
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('read-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    await uploadBytes(
      ref(aliceStorage, 'sessions/s1.json'),
      new Blob(['{}']),
      { contentType: 'application/json' },
    );

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    const r = ref(anonStorage, 'sessions/s1.json');
    await expect(getBlob(r)).rejects.toThrow(/unauthorized/);
  });
});

describe('deleteObject / metadata with rules', () => {
  it('denies anonymous delete', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('delete-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    const path = 'sessions/s1.json';
    await uploadBytes(ref(aliceStorage, path), new Blob(['{}']), {
      contentType: 'application/json',
    });

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    await expect(deleteObject(ref(anonStorage, path))).rejects.toThrow(/unauthorized/);
  });

  it('denies anonymous getMetadata + updateMetadata', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-anon');
    const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    const path = 'sessions/s1.json';
    await uploadBytes(ref(aliceStorage, path), new Blob(['{}']), {
      contentType: 'application/json',
    });

    const anonStorage = getStorageSandbox(sandbox.withAuth(null), { dbName });
    await expect(getMetadata(ref(anonStorage, path))).rejects.toThrow(/unauthorized/);
    await expect(
      updateMetadata(ref(anonStorage, path), { customMetadata: { x: '1' } }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe('metadata-based authorization threads through real ops (#764)', () => {
  const path = 'docs/d1.json';

  function metadataStorage(sandbox: ReturnType<typeof initializeSandbox>, dbName: string, auth: { uid: string } | null) {
    return getStorageSandbox(sandbox.withAuth(auth), { dbName, rules: METADATA_RULES });
  }

  it('lets an owner write then read their own doc (request/resource.metadata populated)', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-owner');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    // Write passes because request.resource.metadata.owner === auth.uid.
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    // Read passes because resource.metadata.owner === auth.uid.
    const blob = await getBlob(ref(alice, path));
    expect(await blob.text()).toBe('{}');
  });

  it('denies a write that claims another user as owner', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-write-spoof');
    const bob = metadataStorage(sandbox, dbName, { uid: 'bob' });
    await expect(
      uploadBytes(ref(bob, path), new Blob(['{}']), {
        contentType: 'application/json',
        customMetadata: { owner: 'alice' },
      }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a non-owner read of a doc owned by someone else', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-read-other');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    const bob = metadataStorage(sandbox, dbName, { uid: 'bob' });
    await expect(getBlob(ref(bob, path))).rejects.toThrow(/unauthorized/);
  });

  it('denies an anonymous read of an owned doc', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('md-read-anon');
    const alice = metadataStorage(sandbox, dbName, { uid: 'alice' });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
      customMetadata: { owner: 'alice' },
    });
    const anon = metadataStorage(sandbox, dbName, null);
    await expect(getBlob(ref(anon, path))).rejects.toThrow(/unauthorized/);
  });
});

describe('granular verbs thread through real ops (create vs update)', () => {
  // Only `create` is granted: the first upload to a fresh path (a
  // create) succeeds; a second upload over the now-existing object (an
  // update) is denied. The caller classifies the op by object existence.
  const CREATE_ONLY = `
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow create: if request.auth != null;
      allow read: if request.auth != null;
    }
  }
}`;

  const path = 'files/f1.json';

  it('allows the initial create but denies an overwrite update', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('granular-create-only');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: CREATE_ONLY });
    // First upload = create → allowed.
    await uploadBytes(ref(alice, path), new Blob(['{}']), { contentType: 'application/json' });
    // Second upload over the existing object = update → denied.
    await expect(
      uploadBytes(ref(alice, path), new Blob(['{"v":2}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies a delete when only create/read are granted', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('granular-no-delete');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: CREATE_ONLY });
    await uploadBytes(ref(alice, path), new Blob(['{}']), { contentType: 'application/json' });
    await expect(deleteObject(ref(alice, path))).rejects.toThrow(/unauthorized/);
  });
});

describe('no-rules mode is open', () => {
  it('uploads + reads succeed when no rules are configured', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: uniqueDbName('no-rules'),
    });
    const r = ref(storage, 'anything/here.txt');
    await uploadBytes(r, new Blob(['ok'])); // no auth, no contentType — allowed
    expect(await (await getBlob(r)).text()).toBe('ok');
  });
});

// ─── Late rules config is loud (silent-rules-wipe guard) ──────────

describe('late rules configuration throws instead of silently discarding', () => {
  const DENY_ALL = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if false;
  }
}`;

  it('optionless first call, rules later → throws (service opened without rules)', () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-open') });
    expect(() =>
      getStorageSandbox(sandbox, { rules: DENY_ALL }),
    ).toThrow(/first storage call/);
  });

  it('admin plane first, rules later → throws (getAdminStorageSandbox opened the service)', async () => {
    const { getAdminStorageSandbox } = await import('../../src/storage/internal.js');
    const sandbox = initializeSandbox({});
    getAdminStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-admin') });
    expect(() =>
      getStorageSandbox(sandbox, { rules: DENY_ALL }),
    ).toThrow(/already open without rules/);
  });

  it('a DIFFERENT rules source after a rules-configured open → throws', () => {
    const sandbox = initializeSandbox({});
    getStorageSandbox(sandbox, { dbName: uniqueDbName('late-rules-diff'), rules: DENY_ALL });
    expect(() =>
      getStorageSandbox(sandbox, { rules: SESSION_ARCHIVE_RULES }),
    ).toThrow(/different rules source/);
  });

  it('re-supplying the IDENTICAL rules source stays allowed (idempotent per-user handles)', () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('late-rules-same');
    getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: DENY_ALL });
    expect(() =>
      getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), { dbName, rules: DENY_ALL }),
    ).not.toThrow();
  });
});

// ─── firestore lookups thread through real storage enforcement ────
//
// End-to-end: a storage rule reads a Firestore document from the SAME
// sandbox to authorize an upload (the premium-user pattern). Enforcement
// (`enforce.ts`) builds the lookup capability from the sandbox's admin
// Firestore accessor (`sandbox.admin.getDocument`, a synchronous
// in-memory read) and injects it into the pure evaluator.
const PREMIUM_UPLOAD_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true;
    }
  }
}`;

describe('firestore lookups thread through real storage enforcement', () => {
  const path = 'uploads/report.json';

  it('allows an upload when the user\'s Firestore doc says premium == true', async () => {
    const sandbox = initializeSandbox({});
    // Seed the acting user's Firestore doc via the admin plane.
    sandbox.admin.setDocument('users/alice', { premium: true });
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-premium-allow'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await uploadBytes(ref(alice, path), new Blob(['{}']), {
      contentType: 'application/json',
    });
    // No throw = allowed.
  });

  it('denies an upload when the user\'s Firestore doc is not premium', async () => {
    const sandbox = initializeSandbox({});
    sandbox.admin.setDocument('users/bob', { premium: false });
    const bob = getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), {
      dbName: uniqueDbName('fs-premium-deny'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await expect(
      uploadBytes(ref(bob, path), new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('denies an upload when the user has no Firestore doc (get on missing doc errors → deny)', async () => {
    const sandbox = initializeSandbox({});
    const carol = getStorageSandbox(sandbox.withAuth({ uid: 'carol' }), {
      dbName: uniqueDbName('fs-premium-missing'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    await expect(
      uploadBytes(ref(carol, path), new Blob(['{}']), { contentType: 'application/json' }),
    ).rejects.toThrow(/unauthorized/);
  });

  it('reads only the Firestore view owned by the same sandbox', async () => {
    const primary = initializeSandbox({});
    const secondary = initializeSandbox({});
    primary.admin.setDocument('users/alice', { premium: true });
    secondary.admin.setDocument('users/alice', { premium: false });

    const primaryStorage = getStorageSandbox(primary.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-project-primary'),
      rules: PREMIUM_UPLOAD_RULES,
    });
    const secondaryStorage = getStorageSandbox(secondary.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-project-secondary'),
      rules: PREMIUM_UPLOAD_RULES,
    });

    await uploadBytes(ref(primaryStorage, path), new Blob(['{}']));
    await expect(uploadBytes(ref(secondaryStorage, path), new Blob(['{}']))).rejects.toThrow(/unauthorized/);
  });

  it('bypasses Firestore client rules when Storage evaluates its qualified lookup', async () => {
    const sandbox = initializeSandbox({});
    setFirestoreRules(sandbox, `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } }
    }`);
    sandbox.admin.setDocument('users/alice', { premium: true });
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('fs-rules-independent'),
      rules: PREMIUM_UPLOAD_RULES,
    });

    await uploadBytes(ref(storage, path), new Blob(['{}']));
  });
});

// ─── resource object-identity / time fields ───────────────────────────────────

/** Extension guard on the object's FULL path (`resource.name`), plus an
 *  immutability check on the server timestamps. Both fields come from the
 *  persisted object record, so these rules only work if the persistence layer
 *  actually feeds them into the evaluator. */
const OBJECT_IDENTITY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileId} {
      allow write: if true;
      // Only image objects are readable — matched against the FULL object path.
      allow get: if resource.name.matches('uploads/.*[.]png');
      // A metadata update is allowed only while the object was never modified.
      allow update: if resource.timeCreated == resource.updated;
    }
  }
}`;

describe('resource object-identity / time fields thread through real ops', () => {
  it('resource.name is the FULL object path, so an extension guard admits a .png', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-name-png');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/pic.png';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'image/png' });
    const blob = await getBlob(ref(alice, path));
    expect(await blob.text()).toBe('x');
  });

  it('the same guard denies a .txt — the field is read, not silently undefined', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-name-txt');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/notes.txt';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'text/plain' });
    await expect(getBlob(ref(alice, path))).rejects.toThrow(/unauthorized/);
  });

  it('resource.timeCreated == resource.updated admits the first metadata update', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('res-immutable');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OBJECT_IDENTITY_RULES,
    });
    const path = 'uploads/pic.png';
    await uploadBytes(ref(alice, path), new Blob(['x']), { contentType: 'image/png' });
    // Freshly uploaded: timeCreated === updated, so the update is allowed.
    const meta = await updateMetadata(ref(alice, path), { contentType: 'image/png' });
    expect(meta.contentType).toBe('image/png');
  });
});

describe('absent resource properties error and deny (no false-allow)', () => {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{id} {
      allow get: if resource.name != 'nope';
    }
  }
}`);

  /** The regression this guards: modeling an absent field as plain `undefined`
   *  makes `undefined != 'nope'` TRUE in JavaScript, which would ALLOW. */
  it('denies `resource.name != <literal>` when name is absent', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: { size: 10 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Property name is undefined/);
  });

  it('allows the same rule when name is present and differs', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: { size: 10, name: 'x/1' },
    });
    expect(result.allowed).toBe(true);
  });

  it('denies a property read through a null resource (create with no object)', () => {
    const result = evaluateStorageRules(rules, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/1' },
      resource: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Null value error/);
  });
});

describe('production-pinned JS-semantics guards (no false-allow via JS leakage)', () => {
  /** One-condition harness: evaluate `if <cond>` for a create of a-b-c.png. */
  const verdict = (cond: string, path = 'x/a-b-c.png') => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow create: if ${cond};
    }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'a' },
        method: 'create',
        path: `/b/b1/o/${path}`,
        resource: { size: 100, contentType: 'image/png', metadata: { owner: 'a' } },
      },
      resource: null,
    }).allowed;
  };

  /** The regression this guards: JS `in` walks the prototype chain, so
   *  `'toString' in map` would be TRUE → ALLOW; production maps expose own
   *  keys only (pinned by rules-firestore-prototype-chain-keys). */
  it('`in` on maps tests own keys only — prototype names are not keys', () => {
    expect(verdict(`'toString' in request.resource.metadata`)).toBe(false);
    expect(verdict(`'constructor' in {'a': 1}`)).toBe(false);
    expect(verdict(`!('hasOwnProperty' in request.resource.metadata)`)).toBe(true);
    expect(verdict(`'owner' in request.resource.metadata`)).toBe(true);
  });

  /** The regression this guards: JS division by zero yields Infinity, and
   *  `Infinity > n` is TRUE → ALLOW; production errors (denies), while
   *  `error || true` still absorbs to allow. */
  it('division/modulo by zero errors and denies, absorbable by ||', () => {
    expect(verdict('request.resource.size / 0 > 5')).toBe(false);
    expect(verdict('request.resource.size % 0 == 0')).toBe(false);
    expect(verdict('(request.resource.size / 0 == 0) ? true : true')).toBe(false);
    expect(verdict('(request.resource.size / 0 == 0) || true')).toBe(true);
  });

  /** The regression this guards: JS `.slice()` clamps out-of-range bounds;
   *  production errors (pinned by rules-firestore-range-slice-list-and-string:
   *  an end past length denies). */
  it('out-of-range slice bounds error and deny instead of clamping', () => {
    expect(verdict(`fileId.split('-')[0:2].size() == 2`)).toBe(true);
    expect(verdict(`fileId.split('-')[0:9].size() >= 0`)).toBe(false);
    expect(verdict(`'abcdef'[1:4] == 'bcd'`)).toBe(true);
    expect(verdict(`'abc'[1:9].size() >= 0`)).toBe(false);
  });

  /** The regression this guards: `===` on arrays/maps is reference identity,
   *  so a slice or literal could never equal another literal (false-DENY),
   *  and `!=` would false-ALLOW; production compares structurally. */
  it('lists and maps compare structurally under == / !=', () => {
    expect(verdict(`fileId.split('-')[0:2] == ['a', 'b']`)).toBe(true);
    expect(verdict(`['a', 'b'] != ['a', 'b']`)).toBe(false);
    expect(verdict(`{'k': 1} == {'k': 1}`)).toBe(true);
    expect(verdict(`{'k': 1} == {'k': 2}`)).toBe(false);
  });

  it('split() rejects RE2-unsupported constructs with a deny-reason', () => {
    expect(verdict(`fileId.split('(?=x)').size() > 0`)).toBe(false);
  });

  it('size() covers strings, lists, and map own-keys', () => {
    expect(verdict(`'abc'.size() == 3`)).toBe(true);
    expect(verdict(`request.resource.metadata.size() == 1`)).toBe(true);
    expect(verdict(`request.resource.size.size() > 0`)).toBe(false);
  });
});

describe('int/float literal typing (RULES-B5 float model)', () => {
  const verdict = (cond: string) => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow create: if ${cond};
    }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'a' },
        method: 'create',
        path: '/b/b1/o/x/f.png',
        resource: { size: 100, contentType: 'image/png' },
      },
      resource: null,
    }).allowed;
  };

  /** The regression this guards: JS numbers carry no int/float distinction,
   *  so a value-typed `is` called `1.0` an int and int division produced
   *  2.5 — production types by literal form and truncates int ÷ int
   *  (pinned by oracle:rules-storage-type-checks-is and
   *  oracle:rules-storage-float-modulo-unary-minus). */
  it('types numeric literals by form: 1.0 is float, 1 is int', () => {
    expect(verdict('1.0 is float')).toBe(true);
    expect(verdict('1 is int')).toBe(true);
    expect(verdict('1.0 is int')).toBe(false);
    expect(verdict('1 is float')).toBe(false);
  });

  it('int / int truncates toward zero; float division stays float', () => {
    expect(verdict('10 / 4 == 2')).toBe(true);
    expect(verdict('-7 / 2 == -3')).toBe(true);
    expect(verdict('10.0 / 4.0 == 2.5')).toBe(true);
    expect(verdict('10 / 4.0 == 2.5')).toBe(true);
  });

  it('int and float compare by numeric value across the tag', () => {
    expect(verdict('1 == 1.0')).toBe(true);
    expect(verdict('1 < 1.5')).toBe(true);
    expect(verdict('request.resource.size * 0.5 == 50.0')).toBe(true);
    expect(verdict('-(1.5) is float')).toBe(true);
  });
});

describe('late-failure deny reasons name the construct (parse-time → request-time shift)', () => {
  /** Constructs the shared grammar parses but the evaluator does not model
   *  fail at REQUEST time, not parse time. The deny reason must name the
   *  construct so the late failure is diagnosable from the reason trace. */
  const reasons = (rules: string, method: 'get' | 'create' = 'get') => {
    const parsed = parseStorageRules(rules);
    const res = evaluateStorageRules(parsed, {
      request: {
        auth: { uid: 'a' },
        method,
        path: '/b/b1/o/x/f.png',
        resource: method === 'create' ? { size: 1, contentType: 'image/png' } : undefined,
      },
      resource: method === 'get' ? { size: 1 } : null,
    });
    expect(res.allowed).toBe(false);
    return res.reasons.join(' ');
  };

  it('an imported function call names the import and its module', () => {
    expect(
      reasons(`rules_version = '2';
import { isAdmin } from 'shared/helpers';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if isAdmin(request.auth);
    }
  }
}`),
    ).toMatch(/isAdmin\(\) is imported from 'shared\/helpers', but import module resolution is not implemented/);
  });

  it('a locally declared function shadows an imported name and evaluates', () => {
    const parsed = parseStorageRules(`rules_version = '2';
import { isAdmin } from 'shared/helpers';
function isAdmin(auth) {
  return auth != null;
}
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if isAdmin(request.auth);
    }
  }
}`);
    const res = evaluateStorageRules(parsed, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/f.png' },
      resource: { size: 1 },
    });
    expect(res.allowed).toBe(true);
  });

  it('an unsupported builtin method names the method', () => {
    expect(
      reasons(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if fileId.upper() == 'F.PNG';
    }
  }
}`),
    ).toMatch(/unsupported method \.upper\(\)/);
  });

  it('an unmodeled `is` type names the type', () => {
    expect(
      reasons(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if request.time is timestamp;
    }
  }
}`),
    ).toMatch(/'is timestamp' is not supported by the storage evaluator/);
  });
});
