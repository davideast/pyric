import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

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
