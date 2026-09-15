import { expect, test } from 'bun:test';
import { createSdkRateMonitor } from 'pyric/sandbox/internal';
import { observeStorageOperation } from 'pyric/storage/internal';
import { getBytes, getStorage, ref } from '../../../src/serve/worker/client/storage.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';

test('worker reads measure decoded bytes once and retain failed call activity', async () => {
  let deny = false;
  const port: ClientPort = {
    onmessage: null, start() {}, close() {},
    postMessage(message) {
      if (message.t !== 'op') return;
      expect(message.method).toBe('storage.getBytes');
      queueMicrotask(() => port.onmessage?.(new MessageEvent('message', { data: deny
        ? { t: 'res', id: message.id, ok: false, error: { code: 'storage/unauthorized', message: 'Denied' } }
        : { t: 'res', id: message.id, ok: true, value: { dataB64: 'AP+A', size: 3 } },
      })));
    },
  };
  wirePort(port);
  const reference = ref(getStorage({ __kind: 'client-db', port }), 'photo');
  const read = observeStorageOperation('getBytes', getBytes);
  const monitor = createSdkRateMonitor();
  try {
    expect(new Uint8Array(await read(reference))).toEqual(new Uint8Array([0, 255, 128]));
    deny = true;
    await expect(read(reference)).rejects.toThrow('Denied');
    const service = monitor.snapshot().services.find(service => service.service === 'storage')!;
    expect(service.methods.find(method => method.method === 'getBytes')!.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(2);
    expect(service.usageBuckets!.reduce((sum, bucket) => sum + (bucket.downloadedBytes ?? 0), 0)).toBe(3);
  } finally { monitor.dispose(); }
});

test('worker upload callbacks open render windows while transfer accounting stays once per task', async () => {
  const { sdkActivity } = await import('pyric/sandbox/internal');
  const { uploadBytesResumable } = await import('../../../src/serve/worker/client/resumable.js');
  let requests = 0;
  const port: ClientPort = {
    onmessage: null, start() {}, close() {},
    postMessage(message) {
      if (message.t !== 'op') return;
      requests++;
      expect(message.method).toBe('storage.putBytes');
      queueMicrotask(() => port.onmessage?.(new MessageEvent('message', { data: {
        t: 'res', id: message.id, ok: true,
        value: { bucket: 'default', fullPath: 'photo', name: 'photo', size: 3, generation: '1', metageneration: '1', timeCreated: '', updated: '' },
      } })));
    },
  };
  wirePort(port);
  const reference = ref(getStorage({ __kind: 'client-db', port }), 'photo');
  const upload = observeStorageOperation('uploadBytesResumable', uploadBytesResumable);
  const monitor = createSdkRateMonitor();
  const phases: string[] = [];
  const stop = sdkActivity.subscribe(event => { if (event.record.service === 'storage') phases.push(event.phase); });
  try {
    const task = upload(reference, new Uint8Array([1, 2, 3]));
    const beforeCallbacks: string[] = [];
    const off = task.on('state_changed', () => beforeCallbacks.push(phases.at(-1)!));
    task.pause(); task.resume();
    await task;
    off();
    expect(beforeCallbacks.length).toBeGreaterThan(1);
    expect(beforeCallbacks.every(phase => phase === 'progress')).toBe(true);
    expect(phases.filter(phase => phase === 'delivery')).toHaveLength(1);
    expect(requests).toBe(1);
    const service = monitor.snapshot().services.find(service => service.service === 'storage')!;
    expect(service.methods.find(method => method.method === 'uploadBytesResumable')!.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(1);
    expect(service.usageBuckets!.reduce((sum, bucket) => sum + (bucket.uploadedBytes ?? 0), 0)).toBe(3);
  } finally { stop(); monitor.dispose(); }
});
