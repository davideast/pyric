/**
 * FS-B4 — unify Timestamp storage.
 *
 * The split-storage root: `serverTimestamp()` and `Date` inputs resolve to
 * the rules-internal `Timestamp` (`pyric/rules`), but a Timestamp the user
 * *writes directly* — the admin-compat `Timestamp` re-exported as
 * `Timestamp` from `pyric/firestore`, or a raw `firebase/firestore`
 * `Timestamp` — had no write-boundary converter and landed in storage as
 * the compat class. That instance is not a `RulesValue`, so the rules
 * evaluator's `data.createdAt is timestamp` returned FALSE for a
 * user-written Timestamp while a `serverTimestamp()` write passed the same
 * rule. These probes lock the unification: both paths now store the
 * internal class, so `is timestamp` holds, the two are `==`-equal, and the
 * read-path shape is unchanged.
 *
 * Pre-fix behavior (the masked gap): test (b) and (c) FAIL — `allowed`
 * is false / the stored value is the compat class, not the internal one.
 */
import { describe, test, expect } from 'bun:test';
import { userTimestampConverter, KEEP } from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { LocalState } from 'pyric/sandbox/internal';
import { Timestamp as InternalTimestamp } from 'pyric/rules/internal';
import { Timestamp as CompatTimestamp } from '../../../src/sandbox/firestore/admin-compat/types.js';
import { createCompatFirestore } from '../../../src/sandbox/firestore/admin-compat/index.js';

const ALLOW_ALL =
  "rules_version = '2'; service cloud.firestore { " +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

const baseCtx = {
  path: 'p/x',
  method: 'create' as const,
  prior: null,
  fieldPath: 'f',
};

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('userTimestampConverter', () => {
  test('converts a compat Timestamp to the rules-internal Timestamp', () => {
    const ct = CompatTimestamp.fromMillis(1_700_000_000_123);
    const out = userTimestampConverter.convert(ct, baseCtx);
    expect(out).toBeInstanceOf(InternalTimestamp);
    expect((out as InternalTimestamp).toMillis()).toBe(ct.toMillis());
  });

  test('declines the internal Timestamp (idempotent on its own output)', () => {
    const it = InternalTimestamp.fromMillis(123_456);
    expect(userTimestampConverter.convert(it, baseCtx)).toBe(KEEP);
  });

  test('declines non-timestamp values via KEEP', () => {
    expect(userTimestampConverter.convert(42, baseCtx)).toBe(KEEP);
    expect(userTimestampConverter.convert('a', baseCtx)).toBe(KEEP);
    expect(userTimestampConverter.convert(new Date(), baseCtx)).toBe(KEEP);
    expect(userTimestampConverter.convert(null, baseCtx)).toBe(KEEP);
    // A plain `{ seconds, nanoseconds }` object with no `toMillis` is NOT a
    // Timestamp — leave it as user data.
    expect(userTimestampConverter.convert({ seconds: 1, nanoseconds: 2 }, baseCtx)).toBe(KEEP);
  });
});

// ─── LocalState integration — unified storage ─────────────────────────────

describe('FS-B4 — a user-written compat Timestamp is stored as the internal class', () => {
  test('seeded compat Timestamp normalizes to the internal Timestamp', () => {
    const ct = CompatTimestamp.fromMillis(1_700_000_000_000);
    const s = new LocalState({ 'users/u1': { createdAt: ct } });
    const stored = s.get('users/u1')?.['createdAt'];
    expect(stored).toBeInstanceOf(InternalTimestamp);
    expect((stored as InternalTimestamp).toMillis()).toBe(ct.toMillis());
  });
});

// ─── Rules integration — `is timestamp` on a user Timestamp ──────────────

describe('FS-B4 — `is timestamp` accepts a user-written Timestamp', () => {
  function envAllowingIfTimestamp() {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /posts/{p} {' +
        '      allow create: if request.resource.data.createdAt is timestamp;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });
    return env;
  }

  test('a directly-written compat Timestamp passes `is timestamp` (pre-fix: denied)', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: CompatTimestamp.fromMillis(1_700_000_000_000) },
    });
    expect(r.allowed).toBe(true);
  });

  test('a non-timestamp value is still denied — the rule is actually checking', () => {
    const env = envAllowingIfTimestamp();
    const r = env.execute({
      method: 'create', path: 'posts/p1', auth: { uid: 'u1' },
      data: { createdAt: { seconds: 1, nanoseconds: 2 } }, // plain object, not a Timestamp
    });
    expect(r.allowed).toBe(false);
  });
});

// ─── Cross-path equality + range comparability ───────────────────────────

describe('FS-B4 — user Timestamp and serverTimestamp share storage shape', () => {
  test('a serverTimestamp() write and a user Timestamp write land as the same class', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: {} });
    // serverTimestamp() path resolves to the internal Timestamp.
    env.execute({
      method: 'create', path: 'events/server', auth: { uid: 'u1' },
      data: { at: { __type: 'serverTimestamp' } },
    });
    const serverAt = env.getDocument('events/server')?.['at'];
    // user-written Timestamp path — pre-fix this stayed the compat class,
    // so the two writes stored two different classes.
    env.execute({
      method: 'create', path: 'events/user', auth: { uid: 'u1' },
      data: { at: CompatTimestamp.fromMillis(1_700_000_000_500) },
    });
    const userAt = env.getDocument('events/user')?.['at'];
    expect(serverAt).toBeInstanceOf(InternalTimestamp);
    expect(userAt).toBeInstanceOf(InternalTimestamp);
    // Same class → an `==` rule between a stored serverTimestamp and a
    // stored user Timestamp at the same instant would now compare by value,
    // not always-false across two distinct classes.
    expect((userAt as InternalTimestamp).toMillis()).toBe(1_700_000_000_500);
  });

  test('range filter on user-written Timestamps still works (FS-B3 regression guard)', async () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: ALLOW_ALL,
      documents: {
        'e/a': { at: CompatTimestamp.fromMillis(1000) },
        'e/b': { at: CompatTimestamp.fromMillis(3000) },
        'e/c': { at: CompatTimestamp.fromMillis(5000) },
      },
    });
    const db = createCompatFirestore(env, { auth: { uid: 'u' } });
    const snap = await db
      .collection('e')
      .where('at', '>', CompatTimestamp.fromMillis(2000))
      .orderBy('at')
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual(['b', 'c']);
  });
});
