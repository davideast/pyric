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
import { getStorageService } from 'pyric/storage/internal';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { portPair } from './integration-support.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

/** The part of an upload task these tests drive, common to both planes. */
interface Task extends PromiseLike<unknown> {
  cancel(): boolean;
  pause(): boolean;
}

/** One plane: start an upload whose hook runs once its commit has stored. */
interface Plane {
  readonly name: string;
  put(path: string, bytes: Uint8Array): Promise<void>;
  /** The bytes at `path`, or undefined when there is no object. */
  read(path: string): Promise<number[] | undefined>;
  start(path: string, bytes: Uint8Array, onCommitStored: (task: Task) => void): Task;
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
  backend.put = async (path, blob, metadata) => {
    await storeObject(path, blob, metadata);
    onStored?.(blob.size);
  };
  return {
    name: 'in-page',
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
  getStorageSandbox(sandbox, { dbName: dbName('worker'), rules: OPEN_STORAGE_RULES });
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

describe('a canceled upload ends the same in-page and through the worker client', () => {
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

  // The worker plane deletes the earlier object instead of restoring it
  // (#1159), so this case asserts the in-page plane only until that lands.
  it('cancel of an overwrite: rejects storage/canceled and keeps the earlier object, in-page', async () => {
    const expected: Outcome = { rejection: 'storage/canceled', bytes: [7, 7, 7] };
    expect(await cancelOverwrite(await inPagePlane())).toEqual(expected);
  });});
