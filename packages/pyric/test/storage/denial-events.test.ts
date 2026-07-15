/**
 * Storage denial events (storage-denial-events).
 *
 * Before this change, a rules-denied storage op threw a plain
 * `StorageError` with NO trace on the sandbox event stream — invisible
 * to Studio's Traffic surface, the rules inspector, and `sandbox.history()`,
 * unlike Firestore/RTDB, which emit a canonical `kind: 'operation'` event
 * carrying `result: 'deny'` and the evaluator's `reasons`.
 *
 * These tests assert storage now emits a `SandboxOperationEvent` on every
 * enforcement decision (allow, deny, and admin bypass), with field names
 * matching RTDB's `emitOperation` exactly, AND that the thrown
 * `StorageError` is unchanged (events are additive).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import type { SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  getBlob,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-denial-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function operations(events: SandboxEvent[]): SandboxOperationEvent[] {
  return events.filter((e): e is SandboxOperationEvent => e.kind === 'operation');
}

const DENY_ALL = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;

const ALICE_ONLY = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == 'alice';
    }
  }
}`;

describe('storage rules denial lands on the unified event stream', () => {
  it('a rules-denied upload emits exactly one operation event with result "deny", reasons, service "storage", the object path, and the op auth', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: uniqueDbName('deny-upload'),
      rules: DENY_ALL,
    });

    let thrown: unknown;
    try {
      await uploadBytes(ref(storage, 'private/secret.txt'), new Blob(['nope']));
    } catch (e) {
      thrown = e;
    }

    // The error contract to app code is unchanged: it still throws.
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('storage/unauthorized');

    const denies = operations(events).filter(
      (e) => e.service === 'storage' && e.result === 'deny',
    );
    expect(denies.length).toBe(1);
    const deny = denies[0]!;
    expect(deny.path).toBe('private/secret.txt');
    expect(deny.auth).toBeNull();
    expect(deny.reasons).toBeDefined();
    expect(deny.reasons!.length).toBeGreaterThan(0);
    expect(deny.rules?.engine).toBe('storage');

    // No object_put mutation event fired — the write never happened.
    expect(events.some((e) => e.kind === 'service_mutation')).toBe(false);
  });

  it('a rules-denied read (getBlob) emits a deny operation event — reads previously emitted nothing at all', async () => {
    const sandbox = initializeSandbox();
    const dbName = uniqueDbName('deny-read-setup');
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName,
      rules: ALICE_ONLY,
    });
    // Seed via alice's write on the same underlying DB, then attempt a read
    // as anonymous.
    const asAlice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName });
    const r = ref(storage, 'docs/note.txt');
    await uploadBytes(ref(asAlice, 'docs/note.txt'), new Blob(['secret']));

    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    let thrown: unknown;
    try {
      await getBlob(r);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('storage/unauthorized');

    const denies = operations(events).filter((e) => e.service === 'storage' && e.result === 'deny');
    expect(denies.length).toBe(1);
    // Granular verbs (storage-rules-granular-verbs): download enforces the
    // precise `get` verb, not the coarse `read` umbrella.
    expect(denies[0]!.method).toBe('get');
  });

  it('a denied op issued with Studio provenance carries actor "studio" on the deny event', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const storage = getStorageSandbox(sandbox.withAuth(null), {
      dbName: uniqueDbName('deny-provenance'),
      rules: DENY_ALL,
    });

    try {
      await uploadBytes(ref(storage, 'x/y.txt'), new Blob(['x']), undefined, {
        actor: { kind: 'studio' },
      });
    } catch {
      // Expected — denial still throws.
    }

    const deny = operations(events).find((e) => e.service === 'storage' && e.result === 'deny');
    expect(deny).toBeDefined();
    expect(deny!.actor).toEqual({ kind: 'studio' });
  });

  it('an allowed op emits its event with result "allow"', async () => {
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('allow-upload'),
      rules: ALICE_ONLY,
    });

    await uploadBytes(ref(storage, 'docs/ok.txt'), new Blob(['ok']));

    const allows = operations(events).filter((e) => e.service === 'storage' && e.result === 'allow');
    expect(allows.length).toBe(1);
    expect(allows[0]!.path).toBe('docs/ok.txt');
    expect((allows[0]!.auth as { uid: string }).uid).toBe('alice');
    // The mutation event is additive, not replaced.
    expect(events.some((e) => e.kind === 'service_mutation' && (e as { op?: string }).op === 'object_put')).toBe(true);
  });

  it('admin-lens ops bypass rules and emit result "not-applicable" with origin "admin" — rules never ran', async () => {
    const { getAdminStorageSandbox } = await import('../../src/storage/internal.js');
    const sandbox = initializeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbName = uniqueDbName('admin-bypass');
    const adminStorage = getAdminStorageSandbox(sandbox, { dbName, rules: DENY_ALL });

    // DENY_ALL would reject this on the rules-honest handle; admin bypasses.
    await uploadBytes(ref(adminStorage, 'anything.txt'), new Blob(['admin']));

    const adminOps = operations(events).filter((e) => e.service === 'storage' && e.origin === 'admin');
    expect(adminOps.length).toBeGreaterThan(0);
    expect(adminOps[0]!.result).toBe('not-applicable');
    expect(adminOps[0]!.rules).toBeUndefined();
  });
});
