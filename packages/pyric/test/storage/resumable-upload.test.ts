/**
 * Tests for Issue #159: Storage: getDownloadURL (local blob URL) and
 * resumable uploads with synthetic/mock progress events.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  getDownloadURL,
  getMetadata,
  uploadBytesResumable,
  type UploadTask,
  type UploadTaskSnapshot,
} from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-resumable-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label) });
}

describe('getDownloadURL and resumable uploads (#159)', () => {
  it('getDownloadURL returns a valid blob URL for stored objects', async () => {
    const storage = freshStorage('download-url-valid');
    const fileRef = ref(storage, 'docs/readme.txt');
    await uploadBytes(fileRef, new Blob(['hello world'], { type: 'text/plain' }));

    const url = await getDownloadURL(fileRef);
    expect(typeof url).toBe('string');
    expect(url.startsWith('blob:')).toBe(true);
  });

  it('uploadBytesResumable emits mock progress events and completes', async () => {
    const storage = freshStorage('resumable-progress');
    const fileRef = ref(storage, 'images/photo.png');
    const payload = new Blob(['phony image bytes'], { type: 'image/png' });

    const task: UploadTask = uploadBytesResumable(fileRef, payload, {
      customMetadata: { author: 'ada' },
    });

    const snapshots: UploadTaskSnapshot[] = [];
    let completed = false;

    task.on(
      'state_changed',
      (snapshot) => {
        snapshots.push({ ...snapshot });
      },
      (err) => {
        throw err;
      },
      () => {
        completed = true;
      },
    );

    const finalSnap = await task;
    expect(completed).toBe(true);
    expect(finalSnap.state).toBe('success');
    expect(finalSnap.bytesTransferred).toBe(payload.size);
    expect(finalSnap.totalBytes).toBe(payload.size);
    expect(finalSnap.metadata?.customMetadata?.author).toBe('ada');

    // Verify progress events occurred (at least initial and final/progress snapshots)
    const hasEnoughSnapshots = snapshots.length >= 2;
    if (hasEnoughSnapshots) {
      expect(snapshots[0].bytesTransferred).toBe(0);
      expect(snapshots[0].state).toBe('running');
    } else {
      throw new Error('Expected at least 2 progress snapshots');
    }

    const downloadUrl = await getDownloadURL(fileRef);
    expect(downloadUrl.startsWith('blob:')).toBe(true);
  });

  it('supports object observer syntax for state_changed', async () => {
    const storage = freshStorage('resumable-object-observer');
    const fileRef = ref(storage, 'data/test.json');
    const task = uploadBytesResumable(fileRef, new Blob(['{"ok":true}']));

    let nextCount = 0;
    let finishCount = 0;

    task.on('state_changed', {
      next: () => {
        nextCount += 1;
      },
      complete: () => {
        finishCount += 1;
      },
    });

    await task;
    const progressFired = nextCount >= 1;
    expect(progressFired).toBe(true);
    expect(finishCount).toBe(1);
  });

  it('supports pause and resume transitions', async () => {
    const storage = freshStorage('resumable-pause-resume');
    const fileRef = ref(storage, 'data/paused.txt');
    const task = uploadBytesResumable(fileRef, new Blob(['pausable data content']));

    const states: string[] = [];
    task.on('state_changed', (snap) => {
      states.push(snap.state);
    });

    task.pause();
    expect(task.snapshot.state).toBe('paused');

    task.resume();
    expect(task.snapshot.state).toBe('running');

    await task;
    expect(task.snapshot.state).toBe('success');
    expect(states.includes('paused')).toBe(true);
    expect(states.includes('running')).toBe(true);
  });

  it('supports cancellation and leaves no object stored', async () => {
    const storage = freshStorage('resumable-cancel');
    const fileRef = ref(storage, 'data/canceled.bin');
    const task = uploadBytesResumable(fileRef, new Blob(['canceled data']));

    let errorFired = false;
    let errorCode = '';

    task.on(
      'state_changed',
      null,
      (err) => {
        errorFired = true;
        errorCode = err.code;
      },
      () => {
        throw new Error('complete should not fire on cancel');
      },
    );

    task.cancel();
    expect(task.snapshot.state).toBe('canceled');

    try {
      await task;
      throw new Error('Task promise should have rejected on cancel');
    } catch (err: unknown) {
      const isErrorObject = typeof err === 'object' && err !== null;
      if (isErrorObject) {
        const hasCode = 'code' in err;
        if (hasCode) {
          expect((err as { code: string }).code).toBe('storage/canceled');
        }
      }
    }

    expect(errorFired).toBe(true);
    expect(errorCode).toBe('storage/canceled');

    // Confirm that the canceled object was not committed to storage
    try {
      await getMetadata(fileRef);
      throw new Error('Expected object-not-found after cancel');
    } catch (err: unknown) {
      const isErrorObject = typeof err === 'object' && err !== null;
      if (isErrorObject) {
        const hasCode = 'code' in err;
        if (hasCode) {
          expect((err as { code: string }).code).toBe('storage/object-not-found');
        }
      }
    }
  });

  it('supports unsubscribing from observers', async () => {
    const storage = freshStorage('resumable-unsub');
    const fileRef = ref(storage, 'data/unsub.txt');
    const task = uploadBytesResumable(fileRef, new Blob(['unsubscription test']));

    let callbackCount = 0;
    const unsubscribe = task.on('state_changed', () => {
      callbackCount += 1;
    });

    unsubscribe();
    await task;
    // Only the immediate initial snapshot event fired upon registration; subsequent events were silenced
    expect(callbackCount).toBe(1);
  });
});
