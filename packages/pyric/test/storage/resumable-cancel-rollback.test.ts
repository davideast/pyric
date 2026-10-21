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
import { describe, it, expect } from 'bun:test';
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

/**
 * Hook the backend so `hook` runs once the commit of `size` bytes is stored,
 * and every write after it is slowed, as a rollback over a slow disk is.
 */
async function hookCommit(storage: FirebaseStorage, size: number, hook: CommitHook): Promise<StorageBackend> {
  const backend = (await getStorageService(storage)).backend;
  const put = backend.put.bind(backend);
  const remove = backend.delete.bind(backend);
  let fired = false;
  backend.put = async (path, blob, metadata) => {
    if (fired) await delay(ROLLBACK_DELAY_MS);
    await put(path, blob, metadata);
    const isTheCommit = !fired && blob.size === size;
    if (isTheCommit) {
      fired = true;
      await hook.afterCommitStored();
    }
  };
  backend.delete = async (path, bucket) => {
    if (fired) await delay(ROLLBACK_DELAY_MS);
    await remove(path, bucket);
  };
  return backend;
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
    const observed: string[] = [];
    let canceledReturned: boolean | undefined;
    await hookCommit(storage, 4, {
      afterCommitStored() {
        canceledReturned = task?.cancel();
        observed.push(task?.snapshot.state ?? 'none');
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    task.on('state_changed', null, (error) => observed.push((error as { code: string }).code));

    const rejection = await rejectionOf(task);

    expect(canceledReturned).toBe(true);
    expect(observed).toEqual(['storage/canceled', 'canceled']);
    expect(rejection.code).toBe('storage/canceled');
    await expect(getMetadata(fileRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
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
    await hookCommit(storage, 4, {
      afterCommitStored() {
        task?.pause();
        stored();
      },
    });
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    await commitStored;
    expect(task.snapshot.state).toBe('paused');

    expect(task.cancel()).toBe(true);
    expect((await rejectionOf(task)).code).toBe('storage/canceled');

    await expect(getMetadata(fileRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
  });

  it('reports a commit that stored while paused once the task resumes', async () => {
    const storage = freshStorage('paused-resumed');
    const fileRef = ref(storage, 'cancel/paused-resumed.bin');
    let task: UploadTask | undefined;
    let stored!: () => void;
    const commitStored = new Promise<void>((resolve) => { stored = resolve; });
    await hookCommit(storage, 4, {
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
    expect((await getMetadata(fileRef)).generation).toBe(done.metadata.generation);
    expect(await bytesAt(fileRef)).toEqual([1, 2, 3, 4]);
  });

  it('rejects with the rollback delete\'s own error when that delete fails', async () => {
    const storage = freshStorage('rollback-fails');
    const fileRef = ref(storage, 'cancel/rollback-fails.bin');
    let task: UploadTask | undefined;
    const observed: string[] = [];
    const backend = await hookCommit(storage, 4, { afterCommitStored: () => { task?.cancel(); } });
    backend.delete = async () => {
      throw Object.assign(new Error('The disk is full.'), { code: 'storage/retry-limit-exceeded' });
    };
    task = uploadBytesResumable(fileRef, new Uint8Array([1, 2, 3, 4]));
    task.on('state_changed', null, (error) => observed.push((error as { code: string }).code));

    const rejection = await rejectionOf(task);

    expect(observed).toEqual(['storage/canceled']);
    expect(rejection.code).toBe('storage/retry-limit-exceeded');
    expect(String((rejection as Error).message)).toContain("'cancel/rollback-fails.bin'");
    expect(await bytesAt(fileRef)).toEqual([1, 2, 3, 4]);
  });
});
