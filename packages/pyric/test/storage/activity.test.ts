import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as storage from '../../src/storage/index.js';
import { createSdkRateMonitor } from '../../src/sandbox/internal/sdk-rates.js';

test('Storage records public calls once and completed bytes without counting URL fetches or progress', async () => {
  const monitor = createSdkRateMonitor();
  const sandbox = initializeSandbox();
  const handle = storage.getStorageSandbox(sandbox, { dbName: `activity-${crypto.randomUUID()}`, rules: `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }` });
  const ref = storage.ref(handle, 'attachments/hello.txt');
  try {
    await storage.uploadString(ref, 'hello');
    await storage.getBytes(ref);
    await storage.getBlob(ref);
    await storage.getDownloadURL(ref);
    await storage.getMetadata(ref);
    await storage.listAll(storage.ref(handle));
    const task = storage.uploadBytesResumable(ref, new Uint8Array([1, 2, 3]));
    expect(typeof task.pause).toBe('function');
    task.on('state_changed', () => {});
    await task;
    await storage.deleteObject(ref);
    await expect(storage.getBytes(ref)).rejects.toThrow();
    const snapshot = monitor.snapshot().services.find(s => s.service === 'storage')!;
    expect(snapshot.coverage).toBe('partial');
    const calls = (name: string) => snapshot.methods.find(m => m.method === name)!.buckets.reduce((sum, b) => sum + b.calls, 0);
    expect(calls('uploadString')).toBe(1);
    expect(calls('uploadBytes')).toBe(0);
    expect(calls('uploadBytesResumable')).toBe(1);
    expect(calls('getBytes')).toBe(2);
    expect(calls('getBlob')).toBe(1);
    expect(calls('deleteObject')).toBe(1);
    expect(snapshot.usageBuckets!.reduce((sum, b) => sum + (b.uploadedBytes ?? 0), 0)).toBe(8);
    expect(snapshot.usageBuckets!.reduce((sum, b) => sum + (b.downloadedBytes ?? 0), 0)).toBe(10);
  } finally { monitor.dispose(); sandbox.dispose(); }
});

test('canceled uploads and denied operations have calls but no completed transfer bytes', async () => {
  const monitor = createSdkRateMonitor();
  const sandbox = initializeSandbox();
  const handle = storage.getStorageSandbox(sandbox, { dbName: `activity-denied-${crypto.randomUUID()}`, rules: `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } } }` });
  const ref = storage.ref(handle, 'private/file');
  try {
    await expect(storage.uploadBytes(ref, new Uint8Array([1]))).rejects.toThrow();
    const task = storage.uploadBytesResumable(ref, new Uint8Array([1, 2]));
    task.cancel();
    await expect(Promise.resolve(task)).rejects.toThrow();
    const service = monitor.snapshot().services.find(s => s.service === 'storage')!;
    expect(service.methods.filter(m => m.observed).map(m => m.method)).toEqual(['uploadBytes', 'uploadBytesResumable']);
    expect(service.usageBuckets!.reduce((sum, b) => sum + (b.uploadedBytes ?? 0), 0)).toBe(0);
  } finally { monitor.dispose(); sandbox.dispose(); }
});
