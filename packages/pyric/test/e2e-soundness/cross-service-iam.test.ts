import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
  type StorageOptions,
} from '../../src/storage/index.js';

// ═══════════════════════════════════════════════════════════════
// Storage to Firestore cross-service IAM dependency
//
// In production, `firestore.get()/exists()` inside Storage rules work
// ONLY when the project's Storage service agent holds
// `roles/firebaserules.firestoreServiceAgent`. Without that grant every
// EXECUTED lookup fails and the rule denies, while a rule whose lookup
// is short-circuited away never executes it and is unaffected.
//
// The real-resource IAM-disabled baseline
// (`packages/conformance/observations/storage-rules/stdlib-realstorage-p3-lookup-budget.json`,
// registry row storage-rules#134) pins exactly that matrix: every
// lookup-executing family DENIES (`storage/unauthorized`) and the
// `true || (lookups)` family still ALLOWS.
//
// The sandbox models the boundary with the `crossServiceIam` storage
// option: 'granted' (the default, the common configured-project state,
// where lookups read the same-sandbox Firestore store) or 'denied'
// (every executed lookup fails exactly like production without the role).
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

/** Mirrors the captured `short` family: `true || (lookup)`. The lookup
 *  is never executed, so the missing IAM grant cannot affect it. */
const SHORT_CIRCUIT_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if true || firestore.exists(/databases/(default)/documents/flags/enabled);
    }
  }
}`;

const UPLOAD_PATH = 'uploads/report.json';

interface UploadCase {
  /** Unique label, used to derive this case's IndexedDB database name. */
  label: string;
  rules: string;
  /** Documents seeded into the sandbox's Firestore store before the upload. */
  seed?: Record<string, Record<string, unknown>>;
  uid?: string;
  crossServiceIam?: 'granted' | 'denied';
}

/**
 * Run one upload through the full sandbox enforcement path and return the
 * promise, so a case can assert either a rejection or a clean resolve.
 */
function upload(testCase: UploadCase): Promise<unknown> {
  const sandbox = initializeSandbox();
  for (const [path, data] of Object.entries(testCase.seed ?? {})) {
    sandbox.admin.setDocument(path, data);
  }
  const options: StorageOptions = {
    dbName: `pyric-cross-service-iam-${testCase.label}-${Math.random().toString(36).slice(2, 10)}`,
    rules: testCase.rules,
  };
  if (testCase.crossServiceIam !== undefined) {
    options.crossServiceIam = testCase.crossServiceIam;
  }
  const storage: FirebaseStorage = getStorageSandbox(
    sandbox.withAuth({ uid: testCase.uid ?? 'alice' }),
    options,
  );
  return uploadBytes(storageRef(storage, UPLOAD_PATH), new Blob(['{}']));
}

describe('Storage to Firestore cross-service IAM dependency', () => {
  describe('crossServiceIam denied: executed lookups deny', () => {
    test('a firestore.get() rule denies even though the doc would authorize', async () => {
      await expect(upload({
        label: 'get-denied',
        rules: LOOKUP_GET_RULES,
        seed: { 'users/alice': { premium: true } },
        crossServiceIam: 'denied',
      })).rejects.toThrow(/unauthorized/);
    });

    test('a firestore.exists() rule denies even though the doc exists', async () => {
      await expect(upload({
        label: 'exists-denied',
        rules: LOOKUP_EXISTS_RULES,
        seed: { 'flags/enabled': { on: true } },
        crossServiceIam: 'denied',
      })).rejects.toThrow(/unauthorized/);
    });

    test('the denial reason names the missing IAM grant, not a generic failure', async () => {
      await expect(upload({
        label: 'reason',
        rules: LOOKUP_GET_RULES,
        seed: { 'users/alice': { premium: true } },
        crossServiceIam: 'denied',
      })).rejects.toThrow(/firebaserules\.firestoreServiceAgent/);
    });
  });

  describe('crossServiceIam denied: short-circuit unaffected', () => {
    test('`true || firestore.exists(...)` still allows (captured `short: ALLOW`)', async () => {
      // No throw means allowed: the lookup was never executed.
      await upload({
        label: 'short',
        rules: SHORT_CIRCUIT_RULES,
        crossServiceIam: 'denied',
      });
    });
  });

  describe('crossServiceIam granted: lookups behave as before', () => {
    test('explicit granted: a firestore.get() rule allows with the authorizing doc', async () => {
      await upload({
        label: 'granted',
        rules: LOOKUP_GET_RULES,
        seed: { 'users/alice': { premium: true } },
        crossServiceIam: 'granted',
      });
    });

    test('the default (option omitted) is granted, so the lookup works', async () => {
      await upload({
        label: 'default',
        rules: LOOKUP_EXISTS_RULES,
        seed: { 'flags/enabled': { on: true } },
      });
    });

    test('granted mode still denies on a missing document (get errors, so deny)', async () => {
      await expect(upload({
        label: 'missing',
        rules: LOOKUP_GET_RULES,
        uid: 'nobody',
        crossServiceIam: 'granted',
      })).rejects.toThrow(/unauthorized/);
    });
  });

  describe('late differing crossServiceIam throws, so the mode never flips silently', () => {
    test('reconfiguring an open service with a DIFFERENT mode throws', () => {
      const sandbox = initializeSandbox();
      getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: `pyric-cross-service-iam-late-${Math.random().toString(36).slice(2, 10)}`,
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

    test('re-supplying the IDENTICAL mode stays allowed (idempotent handles)', () => {
      const sandbox = initializeSandbox();
      const dbName = `pyric-cross-service-iam-same-${Math.random().toString(36).slice(2, 10)}`;
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
