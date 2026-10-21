/**
 * A canceled resumable upload ends the same way in-page and through the
 * worker client (#1161, AGENTS.md rule 3).
 *
 * Both planes commit in one call that cannot be recalled, so each test
 * cancels, or pauses, at the moment the commit has stored its object: the
 * in-page plane from its storage backend's `put`, the worker plane before the
 * host's reply to the commit reaches the client. Each then reads the path
 * after the task rejects, and expects the same outcome from both planes.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import {
  getBytes, getStorageSandbox, ref, uploadBytes, uploadBytesResumable,
} from 'pyric/storage';
import { getStorageService, type StorageBackend } from 'pyric/storage/internal';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { portPair } from './integration-support.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

/** The part of an upload task these tests drive, common to both planes. */
interface Task extends PromiseLike<unknown> {
  cancel(): boolean;
  pause(): boolean;
  on(event: 'state_changed', next: null, error: (error: Error & { code?: string }) => void): () => void;
}

/** One plane: start an upload whose hook runs once its commit has stored. */
interface Plane {
  readonly name: string;
  put(path: string, bytes: Uint8Array): Promise<void>;
  /** The bytes at `path`, or undefined when there is no object. */
  read(path: string): Promise<number[] | undefined>;
  start(path: string, bytes: Uint8Array, onCommitStored: (task: Task) => void): Task;
  /** The Storage backend that holds the plane's objects: the page's, or the host's. */
  readonly backend: StorageBackend;
}

let dbSeq = 0;
function dbName(plane: string): string {
  return `pyric-cancel-parity-${plane}-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function inPagePlane(): Promise<Plane> {
  const sandbox = initializeSandbox();
  const storage = getStorageSandbox(sandbox, { dbName: dbName('in-page'), rules: OPEN_STORAGE_RULES });
  const backend = (await getStorageService(storage)).backend;
  const storeObject = backend.put.bind(backend);
  let onStored: ((blobSize: number) => void) | undefined;
  backend.put = async (path, blob, metadata, issue) => {
    const replaced = await storeObject(path, blob, metadata, issue);
    onStored?.(blob.size);
    return replaced;
  };
  return {
    name: 'in-page',
    backend,
    async put(path, bytes) { await uploadBytes(ref(storage, path), bytes); },
    read: (path) => getBytes(ref(storage, path)).then((buffer) => [...new Uint8Array(buffer)], () => undefined),
    start(path, bytes, onCommitStored) {
      const task = uploadBytesResumable(ref(storage, path), bytes);
      onStored = (blobSize) => {
        const isThisCommit = blobSize === bytes.byteLength;
        if (!isThisCommit) return;
        onStored = undefined;
        onCommitStored(task);
      };
      return task;
    },
  };
}

/** A commit's reply: the stored object's metadata with its rollback token. */
function isCommitReply(message: OutboundMessage): boolean {
  const isValueReply = message.t === 'res' && message.ok && message.value !== null && typeof message.value === 'object';
  return isValueReply && 'rollbackToken' in (message.value as Record<string, unknown>);
}

async function workerPlane(): Promise<Plane> {
  const client = await import('../../../src/serve/worker/client.js');
  const storageClient = await import('../../../src/serve/worker/client/storage.js');
  const sandbox = initializeSandbox();
  const hostStorage = getStorageSandbox(sandbox, { dbName: dbName('worker'), rules: OPEN_STORAGE_RULES });
  const backend = (await getStorageService(hostStorage)).backend;
  getAuth(sandbox);
  await sandbox.enablePersistence({ key: dbName('worker-persistence'), injectedBackend: createMemoryBackend() });
  const ctx: HostCtx = {
    db: getFirestore(sandbox), sandbox, instanceId: 'cancel-parity', subs: new Map(),
    sessionMode: 'LOCAL', sessionBackend: createMemoryBackend(),
  };
  const { a: clientPort, b: hostPort } = portPair();
  let onCommitReply: (() => void) | undefined;
  const toClient: PortLike = {
    postMessage(message: OutboundMessage) {
      const hook = onCommitReply;
      const isTheCommit = hook !== undefined && isCommitReply(message);
      if (isTheCommit) {
        onCommitReply = undefined;
        hook();
      }
      hostPort.postMessage(message);
    },
  };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, toClient, event.data as InboundMessage);
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const storage = storageClient.getStorage(client.getFirestore(`worker://cancel-parity-${dbSeq}`));
  return {
    name: 'worker',
    backend,
    async put(path, bytes) { await storageClient.uploadBytes(storageClient.ref(storage, path), bytes); },
    read: (path) => storageClient.getBytes(storageClient.ref(storage, path)).then((buffer) => [...new Uint8Array(buffer)], () => undefined),
    start(path, bytes, onCommitStored) {
      const task = storageClient.uploadBytesResumable(storageClient.ref(storage, path), bytes);
      onCommitReply = () => onCommitStored(task);
      return task;
    },
  };
}

function codeOfRejection(task: Task): Promise<string | undefined> {
  return Promise.resolve(task).then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );
}

/** What the app sees: the rejection's code, then the bytes at the path. */
interface Outcome {
  readonly rejection: string | undefined;
  readonly bytes: number[] | undefined;
}

async function cancelDuringCommit(plane: Plane): Promise<Outcome> {
  const task = plane.start('cancel/during-commit.bin', new Uint8Array([1, 2, 3, 4]), (started) => {
    started.cancel();
  });
  const rejection = await codeOfRejection(task);
  return { rejection, bytes: await plane.read('cancel/during-commit.bin') };
}

async function cancelWhilePaused(plane: Plane): Promise<Outcome> {
  let stored!: () => void;
  const commitStored = new Promise<void>((resolve) => { stored = resolve; });
  const task = plane.start('cancel/paused.bin', new Uint8Array([1, 2, 3, 4]), (started) => {
    started.pause();
    stored();
  });
  await commitStored;
  task.cancel();
  const rejection = await codeOfRejection(task);
  return { rejection, bytes: await plane.read('cancel/paused.bin') };
}

async function cancelOverwrite(plane: Plane): Promise<Outcome> {
  await plane.put('cancel/overwrite.bin', new Uint8Array([7, 7, 7]));
  const task = plane.start('cancel/overwrite.bin', new Uint8Array([9, 9, 9, 9]), (started) => {
    started.cancel();
  });
  const rejection = await codeOfRejection(task);
  return { rejection, bytes: await plane.read('cancel/overwrite.bin') };
}

/**
 * Cancel during the commit and read the path from the task's error observer,
 * as an app that reacts to the cancel there does. Firebase calls that observer
 * once the upload is canceled, together with the rejection, so the read finds
 * the path as the cancel leaves it. A subscriber that arrives later hears the
 * same error.
 */
async function readFromErrorObserver(plane: Plane, earlier?: Uint8Array) {
  const path = 'cancel/observed.bin';
  if (earlier !== undefined) await plane.put(path, earlier);
  let observed: Promise<{ code: string | undefined; bytes: number[] | undefined }> | undefined;
  // A subscriber that arrives after the cancel, while the rollback runs.
  let midRollback: Promise<{ code: string | undefined; bytes: number[] | undefined }> | undefined;
  const task = plane.start(path, new Uint8Array([9, 9, 9, 9]), (started) => {
    observed = new Promise((resolve) => {
      started.on('state_changed', null, (error) => {
        void plane.read(path).then((bytes) => resolve({ code: error.code, bytes }));
      });
    });
    started.cancel();
    midRollback = new Promise((resolve) => {
      started.on('state_changed', null, (error) => {
        void plane.read(path).then((bytes) => resolve({ code: error.code, bytes }));
      });
    });
  });
  const rejection = await codeOfRejection(task);
  const late = await new Promise<string | undefined>((resolve) => {
    task.on('state_changed', null, (error) => resolve(error.code));
  });
  return { observed: await observed, rejection, late, midRollback: await midRollback };
}

/**
 * Cancel an overwrite during its commit, and land a newer write at the path
 * just after the rollback first reads it: between a check and an act, if the
 * rollback did them apart. The rollback checks the generation in the same
 * backend transaction as its write, so the newer write is kept.
 */
async function newerWriteDuringRollback(plane: Plane): Promise<Outcome> {
  const path = 'cancel/interleaved.bin';
  await plane.put(path, new Uint8Array([7, 7, 7]));
  const backend = plane.backend;
  const read = backend.getMetadata.bind(backend);
  const store = backend.put.bind(backend);
  const restoreReads = () => { backend.getMetadata = read; };
  const task = plane.start(path, new Uint8Array([9, 9, 9, 9]), (started) => {
    backend.getMetadata = async (at, bucket) => {
      const seen = await read(at, bucket);
      const isThePath = at === path;
      if (!isThePath) return seen;
      restoreReads();
      const now = new Date().toISOString();
      await store(path, new Blob([new Uint8Array([5, 5])]), {
        fullPath: path, name: 'interleaved.bin', bucket: seen?.bucket ?? 'pyric-default', generation: '9999999999999999',
        metageneration: '1', timeCreated: now, updated: now, size: 2, contentType: 'application/octet-stream',
      });
      return seen;
    };
    started.cancel();
  });
  const rejection = await codeOfRejection(task);
  restoreReads();
  return { rejection, bytes: await plane.read(path) };
}

/**
 * Cancel an overwrite whose commit read the path just before a newer write
 * landed there: a rollback that kept what it read ahead of the commit would
 * put back the older object. The commit's own write returns the object it
 * replaced, so the rollback puts back the newer write.
 */
async function writeJustBeforeCommit(plane: Plane): Promise<Outcome> {
  const path = 'cancel/stale-prior.bin';
  await plane.put(path, new Uint8Array([7, 7, 7]));
  const backend = plane.backend;
  const read = backend.getMetadata.bind(backend);
  const store = backend.put.bind(backend);
  const restoreReads = () => { backend.getMetadata = read; };
  backend.getMetadata = async (at, bucket) => {
    const seen = await read(at, bucket);
    const isThePath = at === path;
    if (!isThePath) return seen;
    restoreReads();
    const now = new Date().toISOString();
    await store(path, new Blob([new Uint8Array([6, 6])]), {
      fullPath: path, name: 'stale-prior.bin', bucket: seen?.bucket ?? 'pyric-default', generation: '9999999999999998',
      metageneration: '1', timeCreated: now, updated: now, size: 2, contentType: 'application/octet-stream',
    });
    return seen;
  };
  const task = plane.start(path, new Uint8Array([9, 9, 9, 9]), (started) => {
    started.cancel();
  });
  const rejection = await codeOfRejection(task);
  restoreReads();
  return { rejection, bytes: await plane.read(path) };
}

describe('a canceled upload ends the same in-page and through the worker client', () => {
  it('a write that lands just before the commit is what the rollback puts back, on both planes', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: [6, 6] };
    expect(await writeJustBeforeCommit(await inPagePlane())).toEqual(expected);
    expect(await writeJustBeforeCommit(await workerPlane())).toEqual(expected);
  });

  it('a write that lands while the rollback runs is kept, on both planes', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: [5, 5] };
    expect(await newerWriteDuringRollback(await inPagePlane())).toEqual(expected);
    expect(await newerWriteDuringRollback(await workerPlane())).toEqual(expected);
  });

  it('cancel during commit: rejects storage/canceled and leaves no object, on both planes', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: undefined };
    expect(await cancelDuringCommit(await inPagePlane())).toEqual(expected);
    expect(await cancelDuringCommit(await workerPlane())).toEqual(expected);
  });

  it('cancel while paused: rejects storage/canceled and leaves no object, on both planes', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: undefined };
    expect(await cancelWhilePaused(await inPagePlane())).toEqual(expected);
    expect(await cancelWhilePaused(await workerPlane())).toEqual(expected);
  });

  it('cancel of an overwrite: rejects storage/canceled and keeps the earlier object, on both planes (#1159)', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: [7, 7, 7] };
    expect(await cancelOverwrite(await inPagePlane())).toEqual(expected);
    expect(await cancelOverwrite(await workerPlane())).toEqual(expected);
  });

  it('an error observer reads the path as the cancel leaves it, on both planes', async () => {
    const none = { code: 'storage/canceled', bytes: undefined };
    const empty = { observed: none, rejection: 'storage/canceled', late: 'storage/canceled', midRollback: none };
    const earlier = { code: 'storage/canceled', bytes: [7, 7, 7] };
    const kept = { ...empty, observed: earlier, midRollback: earlier };
    for (const plane of [inPagePlane, workerPlane]) {
      expect(await readFromErrorObserver(await plane())).toEqual(empty);
      expect(await readFromErrorObserver(await plane(), new Uint8Array([7, 7, 7]))).toEqual(kept);
    }
  });
});
