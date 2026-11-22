/**
 * Regression tests for #1530: checkpoints and branches capture every Storage
 * bucket's rules and objects (inline and by reference) and every named
 * Realtime Database instance.
 */
import 'fake-indexeddb/auto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { createAppForSandbox } from '../../src/app/internal.js';
import { getAuth, sandbox as authDriver, signInWithEmailAndPassword, signOut } from '../../src/auth/index.js';
import { getOrCreateBackend } from '../../src/database/sandbox/backend-for.js';
import { get, getDatabase, ref as dbRef, sandbox as rtdbSandbox, set } from '../../src/database/index.js';
import { databaseInstanceNamed } from '../../src/sandbox/internal/instances.js';
import { diff, fork, promote } from '../../src/sandbox/branches/engine.js';
import { loadBranch, saveBranch } from '../../src/sandbox/branches/store.js';
import { captureCheckpoint, restoreCheckpoint } from '../../src/sandbox/checkpoints/index.js';
import { assertCheckpointState } from '../../src/sandbox/checkpoints/validation.js';
import { applyFullState, captureFullState } from '../../src/sandbox/full-state.js';
import { initializeSandbox, type LocalSandbox } from '../../src/sandbox/index.js';
import {
  InlineStorageLimitError,
  setInlineStorageLimitForTesting,
} from '../../src/sandbox/internal/inline-storage-limit.js';
import {
  getBytes,
  getMetadata,
  getStorage,
  getStorageSandbox,
  listAll,
  ref as storageRef,
  uploadBytes,
  uploadString,
} from '../../src/storage/index.js';
import {
  deployStorageBucketRules,
  getAdminStorageSandbox,
  getStorageService,
  lockUndeployedStorageBuckets,
  storageBucketsWithRules,
  type StorageBackend,
  type StorageReferenceRecord,
  type StoredMetadata,
  type StoredObject,
} from '../../src/storage/internal.js';
import { installStorageBackend } from '../../src/storage/service.js';

const DEFAULT_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{file} { allow read, write: if true; }
  }
}`;

const MEDIA_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /media/{file} { allow read: if true; allow write: if request.auth != null; }
  }
}`;

const MEDIA_OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /media/{file} { allow read, write: if true; }
  }
}`;

let nextId = 1;

function nextName(label: string): string {
  return `pyric-1530-${label}-${nextId++}`;
}

function appFor(sandbox: LocalSandbox) {
  return createAppForSandbox(
    sandbox,
    {
      projectId: 'demo-app',
      storageBucket: 'demo-app.appspot.com',
      databaseURL: 'https://demo-app-default-rtdb.firebaseio.com',
    },
    nextName('app'),
  );
}

describe('multi-bucket Storage and named RTDB across full state, checkpoints, and branches (#1530)', () => {
  it('captures and restores firebase.json array-form per-bucket rules, undeployed policy, and multi-bucket objects', async () => {
    const source = initializeSandbox();
    getStorageSandbox(source, { dbName: nextName('array-src') });
    deployStorageBucketRules(source, 'demo-app.appspot.com', DEFAULT_BUCKET_RULES);
    deployStorageBucketRules(source, 'media-bucket', MEDIA_BUCKET_RULES);
    lockUndeployedStorageBuckets(source, 'deny');

    const sourceAuth = getAuth(source);
    authDriver.seedUsers(sourceAuth, [{ uid: 'writer-1', email: 'w@example.com', password: 'secret-password' }]);
    const sourceApp = appFor(source);
    await signInWithEmailAndPassword(getAuth(sourceApp), 'w@example.com', 'secret-password');

    await uploadBytes(
      storageRef(getStorage(sourceApp), 'docs/readme.txt'),
      new Uint8Array([104, 105]),
      { contentType: 'text/plain', customMetadata: { lane: 'default' } },
    );
    await uploadBytes(
      storageRef(getStorage(sourceApp, 'gs://media-bucket'), 'media/clip.bin'),
      new Uint8Array([1, 2, 3, 4]),
      { contentType: 'application/octet-stream', customMetadata: { lane: 'media' } },
    );
    await uploadBytes(
      storageRef(getAdminStorageSandbox(source, { bucket: 'archive-bucket' }), 'backups/dump.tar'),
      new Uint8Array([9, 9]),
      { contentType: 'application/x-tar', customMetadata: { lane: 'archive' } },
    );

    const state = await captureFullState(source);
    expect(state.rules.storage).toBeNull();
    expect(state.rules.storageBuckets).toEqual({
      'demo-app.appspot.com': DEFAULT_BUCKET_RULES,
      'media-bucket': MEDIA_BUCKET_RULES,
    });
    expect(state.storage.map((entry) => ({ bucket: entry.bucket, path: entry.path }))).toEqual([
      { bucket: undefined, path: 'docs/readme.txt' },
      { bucket: 'archive-bucket', path: 'backups/dump.tar' },
      { bucket: 'media-bucket', path: 'media/clip.bin' },
    ]);

    const restored = initializeSandbox();
    getStorageSandbox(restored, { dbName: nextName('array-dst') });
    await applyFullState(restored, JSON.parse(JSON.stringify(state)));
    expect(storageBucketsWithRules(restored)).toEqual(['demo-app.appspot.com', 'media-bucket']);

    const restoredApp = appFor(restored);
    await signOut(getAuth(restoredApp));
    expect(
      Array.from(new Uint8Array(await getBytes(storageRef(getStorage(restoredApp), 'docs/readme.txt')))),
    ).toEqual([104, 105]);
    const mediaRef = storageRef(getStorage(restoredApp, 'gs://media-bucket'), 'media/clip.bin');
    expect(Array.from(new Uint8Array(await getBytes(mediaRef)))).toEqual([1, 2, 3, 4]);
    expect((await getMetadata(mediaRef)).customMetadata).toEqual({ lane: 'media' });

    await expect(uploadString(mediaRef, 'blocked')).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });

    await signInWithEmailAndPassword(getAuth(restoredApp), 'w@example.com', 'secret-password');
    await uploadString(storageRef(getStorage(restoredApp, 'gs://media-bucket'), 'media/next.bin'), 'ok');

    // Undeployed archive-bucket keeps its admin-seeded object, while client reads/writes stay locked under 'deny'.
    const restoredArchive = getAdminStorageSandbox(restored, { bucket: 'archive-bucket' });
    expect(
      Array.from(new Uint8Array(await getBytes(storageRef(restoredArchive, 'backups/dump.tar')))),
    ).toEqual([9, 9]);
    await expect(
      getBytes(storageRef(getStorage(restoredApp, 'gs://archive-bucket'), 'backups/dump.tar')),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });

  it('preserves permissive storageUndeployedPolicy ("allow") and isolates sandboxes sharing an IDB database', async () => {
    const sharedDb = nextName('shared-idb');
    const writer = initializeSandbox();
    getStorageSandbox(writer, { dbName: sharedDb });
    deployStorageBucketRules(writer, 'demo-app.appspot.com', DEFAULT_BUCKET_RULES);
    lockUndeployedStorageBuckets(writer, 'allow');
    await uploadBytes(
      storageRef(getAdminStorageSandbox(writer, { bucket: 'permissive-extra' }), 'open/item.txt'),
      new Uint8Array([7, 8]),
    );

    const captured = await captureFullState(writer);
    expect(captured.rules.storageUndeployedPolicy).toBe('allow');
    expect(captured.storage.map((entry) => ({ bucket: entry.bucket, path: entry.path }))).toEqual([
      { bucket: 'permissive-extra', path: 'open/item.txt' },
    ]);

    // A separate sandbox opening only the default bucket on the same IDB database must not sweep in writer's named bucket.
    const isolatedReader = initializeSandbox();
    getStorageSandbox(isolatedReader, { dbName: sharedDb });
    const beforeRead = await captureFullState(isolatedReader);
    await listAll(storageRef(getAdminStorageSandbox(isolatedReader), ''));
    const afterRead = await captureFullState(isolatedReader);
    expect(afterRead.storage).toEqual(beforeRead.storage);

    const target = initializeSandbox();
    getStorageSandbox(target, { dbName: nextName('permissive-target') });
    await applyFullState(target, captured);
    const clientApp = appFor(target);
    expect(
      Array.from(
        new Uint8Array(
          await getBytes(storageRef(getStorage(clientApp, 'gs://permissive-extra'), 'open/item.txt')),
        ),
      ),
    ).toEqual([7, 8]);
  });

  it('captures and restores multi-bucket objects by SHA-256 reference and enforces the inline byte cap across buckets', async () => {
    const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
    const rows = new Map<string, Map<string, { sha256: string; size: number; mime: string; metadata: StoredMetadata }>>();

    function bucketRows(bucket: string): Map<string, { sha256: string; size: number; mime: string; metadata: StoredMetadata }> {
      let map = rows.get(bucket);
      if (map === undefined) {
        map = new Map();
        rows.set(bucket, map);
      }
      return map;
    }

    function makeRefBackend(scope?: string): StorageBackend {
      const activeBucket = scope ?? 'pyric-default';
      return {
        async put(path, blob, metadata, issueGeneration): Promise<StoredObject | undefined> {
          const bucket = metadata.bucket || activeBucket;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const sha256 = `sha-${bucket}-${path}-${bytes.byteLength}`.padEnd(64, '0').slice(0, 64);
          if (issueGeneration !== undefined) {
            metadata.generation = issueGeneration(undefined);
          }
          blobs.set(sha256, { bytes, mime: blob.type });
          bucketRows(bucket).set(path, { sha256, size: bytes.byteLength, mime: blob.type, metadata: structuredClone(metadata) });
          return undefined;
        },
        async deleteIfGeneration(path, generation, bucket = activeBucket): Promise<boolean> {
          const row = rows.get(bucket)?.get(path);
          if (row === undefined || row.metadata.generation !== generation) return false;
          rows.get(bucket)?.delete(path);
          return true;
        },
        async replaceIfGeneration(path, generation, prior, bucket = activeBucket): Promise<boolean> {
          const row = rows.get(bucket)?.get(path);
          if (row === undefined || row.metadata.generation !== generation) return false;
          if (prior === undefined) {
            rows.get(bucket)?.delete(path);
            return true;
          }
          const bytes = new Uint8Array(await prior.blob.arrayBuffer());
          const sha256 = `sha-${bucket}-${path}-${bytes.byteLength}`.padEnd(64, '0').slice(0, 64);
          blobs.set(sha256, { bytes, mime: prior.blob.type });
          bucketRows(bucket).set(path, { sha256, size: bytes.byteLength, mime: prior.blob.type, metadata: structuredClone(prior.metadata) });
          return true;
        },
        async getBlob(path, bucket = activeBucket): Promise<Blob | undefined> {
          const row = rows.get(bucket)?.get(path);
          if (row === undefined) return undefined;
          const held = blobs.get(row.sha256);
          if (held === undefined) return undefined;
          return new Blob([held.bytes as BlobPart], { type: row.mime });
        },
        async getMetadata(path, bucket = activeBucket): Promise<StoredMetadata | undefined> {
          const row = rows.get(bucket)?.get(path);
          return row === undefined ? undefined : structuredClone(row.metadata);
        },
        async getObject(path, bucket = activeBucket): Promise<StoredObject | undefined> {
          const row = rows.get(bucket)?.get(path);
          if (row === undefined) return undefined;
          const held = blobs.get(row.sha256);
          if (held === undefined) return undefined;
          return { blob: new Blob([held.bytes as BlobPart], { type: row.mime }), metadata: structuredClone(row.metadata) };
        },
        async putMetadata(path, metadata, bucket = activeBucket): Promise<void> {
          const row = rows.get(bucket)?.get(path);
          if (row !== undefined) row.metadata = structuredClone(metadata);
        },
        async delete(path, bucket = activeBucket): Promise<void> {
          rows.get(bucket)?.delete(path);
        },
        async listByPrefix(prefix, bucket = activeBucket): Promise<StoredMetadata[]> {
          const found: StoredMetadata[] = [];
          for (const [key, row] of rows.get(bucket)?.entries() ?? []) {
            if (key.startsWith(prefix)) found.push(structuredClone(row.metadata));
          }
          return found;
        },
        async reset(bucket = scope): Promise<void> {
          if (bucket === undefined) rows.clear();
          else rows.delete(bucket);
        },
        async references(bucket = activeBucket): Promise<StorageReferenceRecord[]> {
          const out: StorageReferenceRecord[] = [];
          for (const row of rows.get(bucket)?.values() ?? []) {
            out.push({
              sha256: row.sha256,
              size: row.size,
              blobType: row.mime,
              metadata: structuredClone(row.metadata),
            });
          }
          return out;
        },
        async putReference(path, reference, mime, metadata): Promise<void> {
          if (!blobs.has(reference.sha256)) throw new Error(`Missing blob ${reference.sha256}`);
          bucketRows(metadata.bucket).set(path, {
            sha256: reference.sha256,
            size: reference.size,
            mime,
            metadata: structuredClone(metadata),
          });
        },
        close(): void {},
        scoped: (nextBucket: string) => makeRefBackend(nextBucket),
      };
    }

    const refSandbox = initializeSandbox();
    installStorageBackend(refSandbox, makeRefBackend());
    await uploadBytes(storageRef(getAdminStorageSandbox(refSandbox), 'root.bin'), new Uint8Array([1, 2]));
    await uploadBytes(
      storageRef(getAdminStorageSandbox(refSandbox, { bucket: 'other-bucket' }), 'nested/obj.bin'),
      new Uint8Array([3, 4, 5]),
    );

    const refCaptured = await captureFullState(refSandbox, { storage: 'reference' });
    expect(
      refCaptured.storage.map((item) => ({ bucket: item.bucket, path: item.path, inline: 'contentBase64' in item })),
    ).toEqual([
      { bucket: undefined, path: 'root.bin', inline: false },
      { bucket: 'other-bucket', path: 'nested/obj.bin', inline: false },
    ]);

    await uploadBytes(
      storageRef(getAdminStorageSandbox(refSandbox, { bucket: 'other-bucket' }), 'nested/extra.bin'),
      new Uint8Array([9]),
    );
    await applyFullState(refSandbox, refCaptured);
    expect(
      Array.from(
        new Uint8Array(
          await getBytes(storageRef(getAdminStorageSandbox(refSandbox, { bucket: 'other-bucket' }), 'nested/obj.bin')),
        ),
      ),
    ).toEqual([3, 4, 5]);
    await expect(
      getBytes(storageRef(getAdminStorageSandbox(refSandbox, { bucket: 'other-bucket' }), 'nested/extra.bin')),
    ).rejects.toMatchObject({ code: 'storage/object-not-found' });

    // Inline byte cap sums across default and named buckets.
    const restoreLimit = setInlineStorageLimitForTesting(10);
    try {
      const capped = initializeSandbox();
      getStorageSandbox(capped, { dbName: nextName('cap') });
      await uploadBytes(storageRef(getAdminStorageSandbox(capped), 'a.bin'), new Uint8Array(6));
      await uploadBytes(
        storageRef(getAdminStorageSandbox(capped, { bucket: 'second-bucket' }), 'b.bin'),
        new Uint8Array(6),
      );
      await expect(captureFullState(capped)).rejects.toBeInstanceOf(InlineStorageLimitError);
    } finally {
      restoreLimit();
    }
  });

  it('checkpoints, branches, diffs, promotes, and validates multi-bucket Storage alongside named RTDB instances', async () => {
    const live = initializeSandbox();
    getStorageSandbox(live, { dbName: nextName('live') });
    deployStorageBucketRules(live, 'demo-app.appspot.com', DEFAULT_BUCKET_RULES);
    deployStorageBucketRules(live, 'media-bucket', MEDIA_BUCKET_RULES);
    authDriver.seedUsers(getAuth(live), [{ uid: 'u1', email: 'u1@example.com', password: 'secret-password' }]);

    const liveApp = appFor(live);
    await signInWithEmailAndPassword(getAuth(liveApp), 'u1@example.com', 'secret-password');

    const defaultDb = getDatabase(liveApp);
    const auditDb = getDatabase(liveApp, 'https://audit-shard.firebaseio.com');
    const rulesOnlyDb = getDatabase(liveApp, 'https://rules-only-shard.firebaseio.com');
    const dataOnlyDb = getDatabase(liveApp, 'https://data-only-shard.firebaseio.com');
    rtdbSandbox.setRules(defaultDb, { rules: { '.read': true, '.write': true } });
    rtdbSandbox.setRules(auditDb, { rules: { events: { '.read': true, '.write': 'auth != null' } } });
    rtdbSandbox.setRules(rulesOnlyDb, { rules: { locked: { '.read': false, '.write': false } } });
    rtdbSandbox.setRules(dataOnlyDb, { rules: { '.read': true, '.write': true } });
    await set(dbRef(defaultDb, 'status'), 'ready');
    await set(dbRef(auditDb, 'events/e1'), { actor: 'u1' });
    await set(dbRef(dataOnlyDb, 'metrics/count'), 7);
    rtdbSandbox.setRules(dataOnlyDb, null);

    await uploadBytes(storageRef(getStorage(liveApp), 'docs/a.txt'), new Uint8Array([65]));
    await uploadBytes(
      storageRef(getStorage(liveApp, 'gs://media-bucket'), 'media/keep.bin'),
      new Uint8Array([10, 20]),
    );

    const checkpoint = await captureCheckpoint(live, { label: 'multi-bucket-rtdb' });
    expect(checkpoint.counts.storage).toBe(2);
    expect(checkpoint.counts.database).toBe(3);

    // Invalid per-bucket Storage rules in a checkpoint fail validation before mutating the target sandbox.
    const corrupted = structuredClone(checkpoint);
    corrupted.state.rules.storageBuckets = { 'media-bucket': 'not valid rules syntax {{{' };
    expect(() => assertCheckpointState(corrupted.state)).toThrow();
    await expect(restoreCheckpoint(live, corrupted)).rejects.toThrow();
    expect(
      Array.from(
        new Uint8Array(await getBytes(storageRef(getStorage(liveApp, 'gs://media-bucket'), 'media/keep.bin'))),
      ),
    ).toEqual([10, 20]);

    // Fork branch, mutate both a named Storage bucket and a named RTDB instance, save/load, diff, and promote.
    const branch = await fork(checkpoint.state);
    await uploadBytes(
      storageRef(getAdminStorageSandbox(branch.sandbox, { bucket: 'media-bucket' }), 'media/added.bin'),
      new Uint8Array([30, 40]),
    );
    deployStorageBucketRules(branch.sandbox, 'media-bucket', MEDIA_OPEN_RULES);
    const branchApp = appFor(branch.sandbox);
    await signInWithEmailAndPassword(getAuth(branchApp), 'u1@example.com', 'secret-password');
    const branchAuditDb = getDatabase(branchApp, 'https://audit-shard.firebaseio.com');
    await set(dbRef(branchAuditDb, 'events/e2'), { actor: 'branch' });

    // Concurrent sibling write on live in media-bucket must survive promotion.
    await uploadBytes(
      storageRef(getStorage(liveApp, 'gs://media-bucket'), 'media/live-sibling.bin'),
      new Uint8Array([99]),
    );

    const branchDir = mkdtempSync(join(tmpdir(), 'pyric-1530-branch-'));
    try {
      await saveBranch(branchDir, 'feature-media', branch, { base: 'multi-bucket-rtdb' });
      const reloaded = await loadBranch(branchDir, 'feature-media');
      if (reloaded === null) throw new Error('Expected feature-media branch to reload.');

      const divergences = await diff(reloaded.branch, live);
      expect(
        divergences.some((d) => d.service === 'storage' && d.bucket === 'media-bucket' && d.path === 'media/live-sibling.bin'),
      ).toBe(true);

      const candidateFork = await fork(checkpoint.state, {
        storageBuckets: { 'media-bucket': MEDIA_OPEN_RULES },
        databaseInstances: { 'audit-shard': { rules: { events: { '.read': true, '.write': true } } } },
      });
      await uploadString(
        storageRef(getStorage(appFor(candidateFork.sandbox), 'gs://media-bucket'), 'media/anon-candidate.txt'),
        'allowed',
      );

      await promote(reloaded.branch, live);
    } finally {
      rmSync(branchDir, { recursive: true, force: true });
    }

    expect(
      Array.from(
        new Uint8Array(await getBytes(storageRef(getStorage(liveApp, 'gs://media-bucket'), 'media/added.bin'))),
      ),
    ).toEqual([30, 40]);
    expect(
      Array.from(
        new Uint8Array(await getBytes(storageRef(getStorage(liveApp, 'gs://media-bucket'), 'media/live-sibling.bin'))),
      ),
    ).toEqual([99]);
    expect((await get(dbRef(auditDb, 'events/e2'))).val()).toEqual({ actor: 'branch' });

    // Pollute a dormant RTDB instance on live before restoreCheckpoint to verify dormant reset.
    const dormantDb = getDatabase(liveApp, 'https://dormant-shard.firebaseio.com');
    rtdbSandbox.setRules(dormantDb, { rules: { '.read': true, '.write': true } });
    await set(dbRef(dormantDb, 'stale/flag'), true);

    // Restoring original checkpoint wipes promoted media/added.bin, live-sibling.bin, events/e2, and dormant-shard.
    await restoreCheckpoint(live, checkpoint);
    const liveMediaService = await getStorageService(getAdminStorageSandbox(live, { bucket: 'media-bucket' }));
    expect((await liveMediaService.backend.listByPrefix('')).map((item) => item.fullPath)).toEqual(['media/keep.bin']);
    expect((await get(dbRef(auditDb, 'events/e2'))).val()).toBeNull();
    expect((await get(dbRef(auditDb, 'events/e1'))).val()).toEqual({ actor: 'u1' });
    expect(getOrCreateBackend(live, databaseInstanceNamed('data-only-shard')).adminGet('metrics/count')).toBe(7);
    expect(getOrCreateBackend(live, databaseInstanceNamed('data-only-shard')).getActiveRules()).toBeNull();
    expect(getOrCreateBackend(live, databaseInstanceNamed('dormant-shard')).adminGet('stale/flag')).toBeNull();
    expect(getOrCreateBackend(live, databaseInstanceNamed('dormant-shard')).getActiveRules()).toBeNull();
    await expect(get(dbRef(rulesOnlyDb, 'locked'))).rejects.toThrow();
  });
});
