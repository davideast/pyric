/**
 * Item 6 — typed error code contract.
 *
 * Each plan-listed mapping has a test asserting `result.error.code`.
 * Existing callers that only consume `allowed` continue to work
 * (the shape extension is purely additive).
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FIRESTORE_ERROR_CODES, makeError } from 'pyric/sandbox/internal';
import { INCREMENT } from 'pyric/sandbox/internal';

const OPEN_RULES =
  "rules_version = '2'; service cloud.firestore {" +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

const CLOSED_RULES =
  "rules_version = '2'; service cloud.firestore {" +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if false; }' +
  '  }' +
  '}';

// ─── Module surface ──────────────────────────────────────────────────────

describe('errors module', () => {
  test('exports the canonical Firestore error code set', () => {
    expect(FIRESTORE_ERROR_CODES).toEqual([
      'permission-denied',
      'not-found',
      'already-exists',
      'failed-precondition',
      'invalid-argument',
      'unauthenticated',
      // Added for the admin-compat wrapper's slice-1 stub + slice-4
      // UNSUPPORTED_VALUE_TYPE checks. Matches the gRPC status canon.
      'unimplemented',
    ]);
  });

  test('makeError builds a structured record', () => {
    expect(makeError('not-found', 'gone')).toEqual({
      code: 'not-found',
      message: 'gone',
    });
  });
});

// ─── execute() — single-op denials ───────────────────────────────────────

describe('LocalEnvironment.execute — typed error codes', () => {
  test('rule denied → permission-denied (write)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: CLOSED_RULES, documents: {} });
    const r = env.execute({
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      data: { x: 1 },
    });
    expect(r.allowed).toBe(false);
    expect(r.error?.code).toBe('permission-denied');
    expect(r.error?.message).toBeDefined();
  });

  test('rule denied → permission-denied (read)', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: CLOSED_RULES, documents: { 'docs/d1': { x: 1 } } });
    const r = env.execute({
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'u1' },
    });
    expect(r.allowed).toBe(false);
    expect(r.error?.code).toBe('permission-denied');
  });

  test('create on existing doc → already-exists', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'docs/d1': { x: 1 } } });
    const r = env.execute({
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      data: { x: 2 },
    });
    expect(r.allowed).toBe(false);
    expect(r.error?.code).toBe('already-exists');
    // Existing doc must be untouched — the structural error fires after
    // rules pass, so demoting `allowed` shouldn't accidentally write.
    expect(env.getDocument('docs/d1')).toEqual({ x: 1 });
  });

  test('update on missing doc → not-found', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const r = env.execute({
      method: 'update',
      path: 'docs/missing',
      auth: { uid: 'u1' },
      data: { x: 1 },
    });
    expect(r.allowed).toBe(false);
    expect(r.error?.code).toBe('not-found');
    expect(env.getDocument('docs/missing')).toBeNull();
  });

  test('delete on missing doc → no-op (matches prod firebase/firestore)', () => {
    // Matrix row Firestore #39: `deleteDoc` on an absent path resolves
    // cleanly in production — no throw, no listener fire, no state
    // change. Oracle:
    //   packages/conformance/observations/firestore/firestore-deletedoc-missing.json
    // The previous behavior (demote to `not-found`) was a divergence
    // from prod; tests now lock the no-op.
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const r = env.execute({
      method: 'delete',
      path: 'docs/missing',
      auth: { uid: 'u1' },
    });
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
    expect(env.getDocument('docs/missing')).toBeNull();
  });

  test('increment() on a string prior OVERWRITES (base 0) — no invalid-argument (FS-B11)', () => {
    // Prod does not error on a type-mismatched prior: `increment(1)` on a
    // string uses base 0 → 1, overwriting the string. Pre-FS-B11 the
    // converter threw and `execute` surfaced `invalid-argument`.
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'counters/c1': { value: 'not-a-number' } },
    });
    const r = env.execute({
      method: 'update',
      path: 'counters/c1',
      auth: { uid: 'u1' },
      data: { value: INCREMENT(1) },
    });
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
    expect(env.getDocument('counters/c1')).toEqual({ value: 1 });
  });

  test('successful write — error is absent', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const r = env.execute({
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      data: { x: 1 },
    });
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('structural error wins over the synthesized permission-denied', () => {
    // Rules pass + structural fail → the more specific code surfaces.
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: { 'docs/d1': { x: 1 } } });
    const r = env.execute({
      method: 'create',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      data: { x: 2 },
    });
    expect(r.error?.code).toBe('already-exists');
    expect(r.error?.code).not.toBe('permission-denied');
  });
});

// ─── batch() — typed errors ──────────────────────────────────────────────

describe('LocalEnvironment.batch — typed error codes', () => {
  test('per-op denial carries error.code on the failing entry', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /allowed/{x} { allow write: if true; }' +
        "    match /denied/{x}  { allow write: if false; }" +
        '  }' +
        '}',
      documents: {},
    });
    const r = env.batch(
      [
        { method: 'create', path: 'allowed/a1', data: { x: 1 } },
        { method: 'create', path: 'denied/d1',  data: { y: 2 } },
      ],
      { uid: 'u1' },
    );
    expect(r.allowed).toBe(false);
    expect(r.results[0]!.allowed).toBe(true);
    expect(r.results[0]!.error).toBeUndefined();
    expect(r.results[1]!.allowed).toBe(false);
    expect(r.results[1]!.error?.code).toBe('permission-denied');
    // Top-level error mirrors the first per-op error.
    expect(r.error?.code).toBe('permission-denied');
    // Atomic: the allowed op must NOT have committed.
    expect(env.getDocument('allowed/a1')).toBeNull();
  });

  test('rules pass but applyBatch rejects → structural error on offender', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'docs/d1': { x: 1 } },
    });
    const r = env.batch(
      [
        { method: 'create', path: 'docs/d2', data: { x: 2 } },
        // Conflicts with the seeded doc — already-exists.
        { method: 'create', path: 'docs/d1', data: { x: 3 } },
      ],
      { uid: 'u1' },
    );
    expect(r.allowed).toBe(false);
    expect(r.results[1]!.error?.code).toBe('already-exists');
    expect(r.error?.code).toBe('already-exists');
    // Atomic: the first op did NOT commit.
    expect(env.getDocument('docs/d2')).toBeNull();
    // Existing doc untouched.
    expect(env.getDocument('docs/d1')).toEqual({ x: 1 });
  });

  test('batch increment() on a string prior commits via FS-B11 overwrite', () => {
    // Pre-FS-B11 a sentinel type-mismatch threw and aborted the batch with
    // `invalid-argument`. Prod overwrites instead (base 0), so the batch
    // commits: the counter becomes 1 and the sibling create lands.
    const env = new LocalEnvironment();
    env.seed({
      rules: OPEN_RULES,
      documents: { 'counters/c1': { value: 'not-a-number' } },
    });
    const r = env.batch(
      [
        { method: 'update', path: 'counters/c1', data: { value: INCREMENT(1) } },
        { method: 'create', path: 'docs/d1', data: { x: 1 } },
      ],
      { uid: 'u1' },
    );
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
    expect(env.getDocument('counters/c1')).toEqual({ value: 1 });
    expect(env.getDocument('docs/d1')).toEqual({ x: 1 });
  });

  test('all-allowed batch — top-level error is absent', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const r = env.batch(
      [
        { method: 'create', path: 'docs/d1', data: { x: 1 } },
        { method: 'create', path: 'docs/d2', data: { x: 2 } },
      ],
      { uid: 'u1' },
    );
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.results.every((x) => x.error === undefined)).toBe(true);
  });
});
