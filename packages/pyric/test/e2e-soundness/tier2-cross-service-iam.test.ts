import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-f9-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 2 — F9: Storage→Firestore cross-service IAM dependency
//
// In production, `firestore.get()/exists()` inside Storage rules work
// ONLY when the project's Storage service agent holds
// `roles/firebaserules.firestoreServiceAgent`. Without that grant every
// EXECUTED lookup fails and the rule denies — while a rule whose lookup
// is short-circuited away never executes it and is unaffected.
//
// The real-resource IAM-DISABLED baseline
// (`packages/conformance/observations/storage-rules/stdlib-realstorage-p3-lookup-budget.json`,
// registry row storage-rules#134) pins exactly that matrix: every
// lookup-executing family DENIES (`storage/unauthorized`) and the
// `true || (lookups…)` family still ALLOWS.
//
// The sandbox models the boundary with the `crossServiceIam` storage
// option: 'granted' (default — the common configured-project state,
// lookups read the same-sandbox Firestore store) or 'denied' (every
// executed lookup fails exactly like production without the role).
// ═══════════════════════════════════════════════════════════════

const LOOKUP_GET_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.premium == true;
    }
  }
}`;

const LOOKUP_EXISTS_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if firestore.exists(/databases/(default)/documents/flags/enabled);
    }
  }
}`;

/** Mirrors the captured `short` family: `true || (lookup)` — the lookup
 *  is never executed, so the missing IAM grant cannot affect it. */
const SHORT_CIRCUIT_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if true || firestore.exists(/databases/(default)/documents/flags/enabled);
    }
  }
}`;

const path = 'uploads/report.json';

describe('F9: Storage→Firestore cross-service IAM dependency', () => {
  // ─── F9.a: denied mode — every EXECUTED lookup fails → rule denies ──
  describe('F9.a: crossServiceIam denied — executed lookups deny', () => {
    test('F9.a1: firestore.get() rule DENIES even though the doc would authorize', async () => {
      const sandbox = initializeSandbox();
      sandbox.admin.setDocument('users/alice', { premium: true });
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('a1-get-denied'),
        rules: LOOKUP_GET_RULES,
        crossServiceIam: 'denied',
      });
      await expect(
        uploadBytes(storageRef(storage, path), new Blob(['{}'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F9.a2: firestore.exists() rule DENIES even though the doc exists', async () => {
      const sandbox = initializeSandbox();
      sandbox.admin.setDocument('flags/enabled', { on: true });
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('a2-exists-denied'),
        rules: LOOKUP_EXISTS_RULES,
        crossServiceIam: 'denied',
      });
      await expect(
        uploadBytes(storageRef(storage, path), new Blob(['{}'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F9.a3: the denial reason names the missing IAM grant, not a generic failure', async () => {
      const sandbox = initializeSandbox();
      sandbox.admin.setDocument('users/alice', { premium: true });
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('a3-reason'),
        rules: LOOKUP_GET_RULES,
        crossServiceIam: 'denied',
      });
      await expect(
        uploadBytes(storageRef(storage, path), new Blob(['{}'])),
      ).rejects.toThrow(/firebaserules\.firestoreServiceAgent/);
    });
  });

  // ─── F9.b: denied mode — a short-circuited lookup never executes ────
  describe('F9.b: crossServiceIam denied — short-circuit unaffected', () => {
    test('F9.b1: `true || firestore.exists(...)` still ALLOWS (captured `short: ALLOW`)', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('b1-short'),
        rules: SHORT_CIRCUIT_RULES,
        crossServiceIam: 'denied',
      });
      await uploadBytes(storageRef(storage, path), new Blob(['{}']));
      // No throw = allowed: the lookup was never executed.
    });
  });

  // ─── F9.c: granted mode — unchanged behavior (pins) ─────────────────
  describe('F9.c: crossServiceIam granted — lookups behave as before', () => {
    test('F9.c1: explicit granted — firestore.get() rule ALLOWS with the authorizing doc', async () => {
      const sandbox = initializeSandbox();
      sandbox.admin.setDocument('users/alice', { premium: true });
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('c1-granted'),
        rules: LOOKUP_GET_RULES,
        crossServiceIam: 'granted',
      });
      await uploadBytes(storageRef(storage, path), new Blob(['{}']));
    });

    test('F9.c2: DEFAULT (option omitted) is granted — lookup works', async () => {
      const sandbox = initializeSandbox();
      sandbox.admin.setDocument('flags/enabled', { on: true });
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('c2-default'),
        rules: LOOKUP_EXISTS_RULES,
      });
      await uploadBytes(storageRef(storage, path), new Blob(['{}']));
    });

    test('F9.c3: granted mode still denies on a missing document (get errors → deny)', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'nobody' }), {
        dbName: uniqueDbName('c3-missing'),
        rules: LOOKUP_GET_RULES,
        crossServiceIam: 'granted',
      });
      await expect(
        uploadBytes(storageRef(storage, path), new Blob(['{}'])),
      ).rejects.toThrow(/unauthorized/);
    });
  });

  // ─── F9.d: configuration seam — first-call semantics stay loud ──────
  describe('F9.d: late differing crossServiceIam throws (no silent mode flip)', () => {
    test('F9.d1: reconfiguring an open service with a DIFFERENT mode throws', async () => {
      const sandbox = initializeSandbox();
      getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('d1-late'),
        rules: SHORT_CIRCUIT_RULES,
        crossServiceIam: 'denied',
      });
      expect(() =>
        getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), {
          rules: SHORT_CIRCUIT_RULES,
          crossServiceIam: 'granted',
        }),
      ).toThrow(/crossServiceIam/);
    });

    test('F9.d2: re-supplying the IDENTICAL mode stays allowed (idempotent handles)', async () => {
      const sandbox = initializeSandbox();
      const dbName = uniqueDbName('d2-same');
      getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName,
        rules: SHORT_CIRCUIT_RULES,
        crossServiceIam: 'denied',
      });
      expect(() =>
        getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), {
          dbName,
          rules: SHORT_CIRCUIT_RULES,
          crossServiceIam: 'denied',
        }),
      ).not.toThrow();
    });
  });
});
