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
