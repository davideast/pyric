/**
 * A canceled in-page resumable upload rolls back before its task rejects,
 * and only the generation it wrote (#1161).
 *
 * The commit is one call that cannot be recalled, so a cancel that races it
 * must wait for it and undo what it stored. Each test hooks the backend's
 * `put` so it acts at the moment the task's commit has stored its object,
 * and slows the rollback's writes, so an app that awaits the rejection and
 * then reads the path would see the object if the task rejected first.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, setSystemTime } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  getBytes,
  getMetadata,
  ref,
  uploadBytes,
  uploadBytesResumable,
  type FirebaseStorage,
  type StorageReference,
  type UploadTask,
} from '../../src/storage/index.js';
import { getStorageService } from '../../src/storage/service.js';
import type { StorageBackend } from '../../src/storage/persistence.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const ROLLBACK_DELAY_MS = 30;

function freshStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  const dbName = `pyric-storage-cancel-rollback-${label}-${Math.random().toString(36).slice(2, 10)}`;
  return getStorageSandbox(sandbox, { dbName, rules: OPEN_RULES });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait past the millisecond so the next write mints a newer generation. */
function nextGeneration(): Promise<void> {
  return delay(3);
}

/**
 * Wait out any rollback still running, so a test of what the rollback
 * removes does not depend on when the task rejected.
 */
function settled(): Promise<void> {
  return delay(ROLLBACK_DELAY_MS * 4);
}

interface CommitHook {
  /** Runs once, right after the task's commit stored its object. */
  afterCommitStored(): Promise<void> | void;
}

interface HookedBackend {
  readonly backend: StorageBackend;
  /** The generation of every write of `size` bytes: the task's commits. */
  readonly commitGenerations: string[];
}

/**
 * Hook the backend so `hook` runs once the commit of `size` bytes is stored,
 * and every write after it is slowed, as a rollback over a slow disk is.
 */
async function hookCommit(storage: FirebaseStorage, size: number, hook: CommitHook): Promise<HookedBackend> {
  const backend = (await getStorageService(storage)).backend;
  const put = backend.put.bind(backend);
  const remove = backend.deleteIfGeneration.bind(backend);
  const replace = backend.replaceIfGeneration.bind(backend);
  const commitGenerations: string[] = [];
  let fired = false;
  backend.put = async (path, blob, metadata, issue) => {
    if (fired) await delay(ROLLBACK_DELAY_MS);
    const replaced = await put(path, blob, metadata, issue);
    const isACommit = blob.size === size;
    if (isACommit) commitGenerations.push(metadata.generation);
    const isTheFirstCommit = isACommit && !fired;
    if (isTheFirstCommit) {
      fired = true;
      await hook.afterCommitStored();
    }
    return replaced;
  };
  // The rollback's writes, slowed once the commit is stored.
  backend.deleteIfGeneration = async (path, generation, bucket) => {
    if (fired) await delay(ROLLBACK_DELAY_MS);
    return remove(path, generation, bucket);
  };
  backend.replaceIfGeneration = async (path, generation, prior, bucket) => {
    if (fired) await delay(ROLLBACK_DELAY_MS);
    return replace(path, generation, prior, bucket);
  };
  return { backend, commitGenerations };
}

/** The error code an observer heard, and what its read of the path found. */
interface ObserverRead {
  readonly code: string;
  readonly read: number[] | string | undefined;
}

/** Read `fileRef` from an error observer, as an app's error handler would. */
function readOnError(task: UploadTask, fileRef: StorageReference): Promise<ObserverRead> {
  return new Promise((resolve) => {
    task.on('state_changed', null, (error) => {
      const code = (error as { code: string }).code;
      void getBytes(fileRef).then(
        (buffer) => resolve({ code, read: [...new Uint8Array(buffer)] }),
        (failure: { code?: string }) => resolve({ code, read: failure.code }),
      );
    });
  });
}

async function bytesAt(fileRef: StorageReference): Promise<number[]> {
  return [...new Uint8Array(await getBytes(fileRef))];
}

function rejectionOf(task: UploadTask): Promise<{ code?: string }> {
  return Promise.resolve(task).then(
    () => { throw new Error('The canceled task resolved.'); },
    (error: { code?: string }) => error,
  );
}

describe('a canceled in-page upload rolls back before it rejects (#1161)', () => {
  it('leaves no object once the rejection of a cancel during commit is seen', async () => {
    const storage = freshStorage('new-object');
    const fileRef = ref(storage, 'cancel/new.bin');
    let task: UploadTask | undefined;
    const atCancel: string[] = [];
    await hookCommit(storage, 4, {
      afterCommitStored() {
        atCancel.push(String(task?.cancel()), task?.snapshot.state ?? 'none');
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));

    const rejection = await rejectionOf(task);

    expect(atCancel).toEqual(['true', 'canceled']);
    expect(rejection.code).toBe('storage/canceled');
    await expect(getMetadata(fileRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
  });

  it('tells error observers once the rollback is done, so a read from the observer finds no object', async () => {
    const storage = freshStorage('observer-read');
    const fileRef = ref(storage, 'cancel/observer-read.bin');
    let task: UploadTask | undefined;
    let lateObserver: Promise<ObserverRead> | undefined;
    await hookCommit(storage, 4, {
      afterCommitStored() {
        task?.cancel();
        if (task !== undefined) lateObserver = readOnError(task, fileRef);
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    const observer = readOnError(task, fileRef);

    expect(await observer).toEqual({ code: 'storage/canceled', read: 'storage/object-not-found' });
    expect(await lateObserver).toEqual({ code: 'storage/canceled', read: 'storage/object-not-found' });
  });

  it('restores the earlier object once the rejection of a canceled overwrite is seen', async () => {
    const storage = freshStorage('overwrite');
    const fileRef = ref(storage, 'cancel/overwrite.bin');
    await uploadBytes(fileRef, new Uint8Array([7, 7, 7]));
    const earlier = await getMetadata(fileRef);
    let task: UploadTask | undefined;
    await hookCommit(storage, 4, { afterCommitStored: () => { task?.cancel(); } });
    task = uploadBytesResumable(fileRef, new Uint8Array([9, 9, 9, 9]));

    expect((await rejectionOf(task)).code).toBe('storage/canceled');

    expect(await bytesAt(fileRef)).toEqual([7, 7, 7]);
    expect((await getMetadata(fileRef)).generation).toBe(earlier.generation);
  });

  it('keeps a newer write that landed while the canceled commit was in flight', async () => {
    const storage = freshStorage('newer-write');
    const fileRef = ref(storage, 'cancel/newer.bin');
    let task: UploadTask | undefined;
    await hookCommit(storage, 4, {
      async afterCommitStored() {
        task?.cancel();
        await nextGeneration();
        await uploadBytes(fileRef, new Uint8Array([5, 5]));
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));

    expect((await rejectionOf(task)).code).toBe('storage/canceled');
    await settled();

    expect(await bytesAt(fileRef)).toEqual([5, 5]);
  });

  // Under a frozen clock the newer write still mints its own generation
  // (#1160), so the rollback tells it apart from the canceled commit.
  it('keeps a newer write that landed in the same millisecond as the canceled commit', async () => {
    setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    try {
      const storage = freshStorage('same-millisecond');
      const fileRef = ref(storage, 'cancel/same-millisecond.bin');
      let task: UploadTask | undefined;
      await hookCommit(storage, 4, {
        async afterCommitStored() {
          task?.cancel();
          await uploadBytes(fileRef, new Uint8Array([5, 5]));
        },
      });
      task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));

      expect((await rejectionOf(task)).code).toBe('storage/canceled');

      expect(await bytesAt(fileRef)).toEqual([5, 5]);
    } finally {
      setSystemTime();
    }
  });

  it('keeps a newer write over a canceled overwrite instead of restoring the earlier object', async () => {
    const storage = freshStorage('newer-over-overwrite');
    const fileRef = ref(storage, 'cancel/newer-overwrite.bin');
    await uploadBytes(fileRef, new Uint8Array([7, 7, 7]));
    let task: UploadTask | undefined;
    await hookCommit(storage, 4, {
      async afterCommitStored() {
        task?.cancel();
        await nextGeneration();
        await uploadBytes(fileRef, new Uint8Array([5, 5]));
      },
    });
    await nextGeneration();
    task = uploadBytesResumable(fileRef, new Uint8Array([9, 9, 9, 9]));

    expect((await rejectionOf(task)).code).toBe('storage/canceled');
    await settled();

    expect(await bytesAt(fileRef)).toEqual([5, 5]);
  });

  it('rolls back a commit that stored while paused once the paused task is canceled', async () => {
    const storage = freshStorage('paused');
    const fileRef = ref(storage, 'cancel/paused.bin');
    let task: UploadTask | undefined;
    let stored!: () => void;
    const commitStored = new Promise<void>((resolve) => { stored = resolve; });
    const hooked = await hookCommit(storage, 4, {
      afterCommitStored() {
        task?.pause();
        stored();
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    await commitStored;
    expect(task.snapshot.state).toBe('paused');
    await delay(ROLLBACK_DELAY_MS * 2);

    expect(task.cancel()).toBe(true);
    expect((await rejectionOf(task)).code).toBe('storage/canceled');

    await expect(getMetadata(fileRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
    expect(hooked.commitGenerations).toHaveLength(1);
  });

  it('reports a commit that stored while paused once the task resumes', async () => {
    const storage = freshStorage('paused-resumed');
    const fileRef = ref(storage, 'cancel/paused-resumed.bin');
    let task: UploadTask | undefined;
    let stored!: () => void;
    const commitStored = new Promise<void>((resolve) => { stored = resolve; });
    const hooked = await hookCommit(storage, 4, {
      afterCommitStored() {
        task?.pause();
        stored();
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    await commitStored;
    await delay(ROLLBACK_DELAY_MS * 2);

    expect(task.resume()).toBe(true);
    const done = await task;

    expect(done.state).toBe('success');
    expect(hooked.commitGenerations).toEqual([done.metadata.generation]);
    expect((await getMetadata(fileRef)).generation).toBe(done.metadata.generation);
    expect(await bytesAt(fileRef)).toEqual([1, 2, 3, 4]);
  });

  it('ends with the rollback delete\'s own error, for observers and the promise alike, when that delete fails', async () => {
    const storage = freshStorage('rollback-fails');
    const fileRef = ref(storage, 'cancel/rollback-fails.bin');
    let task: UploadTask | undefined;
    const { backend } = await hookCommit(storage, 4, { afterCommitStored: () => { task?.cancel(); } });
    backend.deleteIfGeneration = async () => {
      throw diskFull();
    };
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    const observer = readOnError(task, fileRef);

    const rejection = await rejectionOf(task);
    const late = await readOnError(task, fileRef);

    expect(rejection.code).toBe('storage/retry-limit-exceeded');
    expect(String((rejection as Error).message)).toContain("'cancel/rollback-fails.bin' was canceled after it was stored, and removing it failed");
    expect(await observer).toEqual({ code: 'storage/retry-limit-exceeded', read: [1, 2, 3, 4] });
    expect(late).toEqual({ code: 'storage/retry-limit-exceeded', read: [1, 2, 3, 4] });
  });

  it('says it was restoring the earlier object when that restore fails', async () => {
    const storage = freshStorage('restore-fails');
    const fileRef = ref(storage, 'cancel/restore-fails.bin');
    await uploadBytes(fileRef, new Uint8Array([7, 7, 7]));
    let task: UploadTask | undefined;
    const { backend } = await hookCommit(storage, 4, { afterCommitStored: () => { task?.cancel(); } });
    backend.replaceIfGeneration = async () => {
      throw diskFull();
    };
    task = uploadBytesResumable(fileRef, new Uint8Array([9, 9, 9, 9]));

    const rejection = await rejectionOf(task);

    expect(rejection.code).toBe('storage/retry-limit-exceeded');
    expect(String((rejection as Error).message)).toContain('and restoring the object it replaced failed');
  });

  it('records the restore of the earlier object as an object_put', async () => {
    const sandbox = initializeSandbox({});
    const dbName = `pyric-storage-cancel-rollback-events-${Math.random().toString(36).slice(2, 10)}`;
    const storage = getStorageSandbox(sandbox, { dbName, rules: OPEN_RULES });
    const fileRef = ref(storage, 'cancel/restore-event.bin');
    await uploadBytes(fileRef, new Uint8Array([7, 7, 7]));
    const earlier = await getMetadata(fileRef);
    let task: UploadTask | undefined;
    await hookCommit(storage, 4, { afterCommitStored: () => { task?.cancel(); } });
    task = uploadBytesResumable(fileRef, new Uint8Array([9, 9, 9, 9]));
    await rejectionOf(task);

    const events = storageMutationsAt(sandbox.history(), 'cancel/restore-event.bin');
    expect(events.map((event) => event.op)).toEqual(['object_put', 'object_put', 'object_put']);
    expect(events[2]?.after).toMatchObject({ generation: earlier.generation, size: 3 });
  });
});

function diskFull(): Error {
  return Object.assign(new Error('The disk is full.'), { code: 'storage/retry-limit-exceeded' });
}

interface StorageMutation {
  readonly op: string;
  readonly after?: { generation?: string; size?: number };
}

function storageMutationsAt(history: readonly unknown[], path: string): StorageMutation[] {
  const mutations = history as readonly { kind?: string; service?: string; path?: string }[];
  return mutations
    .filter((event) => event.kind === 'service_mutation' && event.service === 'storage' && event.path === path)
    .map((event) => event as StorageMutation);
}
