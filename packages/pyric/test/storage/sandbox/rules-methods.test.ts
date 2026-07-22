import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

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
