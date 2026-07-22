import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

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

type StorageResourceLike = { size: number; contentType?: string; metadata?: Record<string, string> } | null;
