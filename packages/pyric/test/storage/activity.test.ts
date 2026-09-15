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

test('Storage progress is observed before callbacks without counting extra calls, results, or bytes', async () => {
  const { sdkActivity } = await import('../../src/sandbox/internal/sdk-activity.js');
  const sandbox = initializeSandbox();
  const handle = storage.getStorageSandbox(sandbox, { dbName: `flow-${crypto.randomUUID()}`, rules: `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }` });
  const monitor = createSdkRateMonitor();
  const phases: string[] = [];
  const stop = sdkActivity.subscribe(event => { if (event.record.service === 'storage') phases.push(event.phase); });
  try {
    const task = storage.uploadBytesResumable(storage.ref(handle, 'flow.bin'), new Uint8Array(1024));
    let callbacks = 0;
    const unsubscribe = task.on('state_changed', () => {
      callbacks++;
      expect(phases.at(-1)).toBe('progress');
    });
    task.pause();
    task.resume();
    await task;
    unsubscribe();
    expect(callbacks).toBeGreaterThan(1);
    expect(phases.filter(phase => phase === 'delivery')).toHaveLength(1);
    const service = monitor.snapshot().services.find(service => service.service === 'storage')!;
    const upload = service.methods.find(method => method.method === 'uploadBytesResumable')!;
    expect(upload.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(1);
    expect(service.usageBuckets!.reduce((sum, bucket) => sum + (bucket.uploadedBytes ?? 0), 0)).toBe(1024);
  } finally { stop(); monitor.dispose(); }
});

test('each completion observer and late successful observer has a render signal without duplicate results', async () => {
  const { sdkActivity } = await import('../../src/sandbox/internal/sdk-activity.js');
  const sandbox = initializeSandbox();
  const handle = storage.getStorageSandbox(sandbox, { dbName: `late-${crypto.randomUUID()}`, rules: `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }` });
  const signals: string[] = [];
  let results = 0;
  const stop = sdkActivity.subscribe(event => { if (event.record.service === 'storage') { signals.push(event.phase); if (event.phase === 'delivery') results++; } });
  try {
    const task = storage.uploadBytesResumable(storage.ref(handle, 'late'), new Uint8Array(3));
    const callbackSignals: string[] = [];
    const completion = () => { callbackSignals.push(signals.at(-1)!); signals.length = 0; };
    task.on('state_changed', { complete: completion });
    task.on('state_changed', { complete: completion });
    await task;
    expect(callbackSignals).toEqual(['progress', 'progress']);
    expect(signals).toContain('progress'); // window for the awaited result
    signals.length = 0;
    task.on('state_changed', { next: completion, complete: completion });
    expect(callbackSignals).toEqual(['progress', 'progress', 'progress', 'progress']);
    expect(results).toBe(1);
  } finally { stop(); }
});
