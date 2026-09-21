import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { ref, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, installStorageBackend } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

const path = 'narrations/test.timings.json';
const persistence = await createHostedPersistence(join(process.argv[2], 'race'));
const sandbox = createSandboxRoot({ mutations: 1000, spans: 1000 });
installStorageBackend(sandbox, persistence.storage);
const target = ref(getAdminStorageSandbox(sandbox), path);

function payload(text: string, asBlob: boolean): Blob | Uint8Array {
  const bytes = Buffer.from(JSON.stringify({ text, pad: 'x'.repeat(4000) }));
  if (asBlob) return new Blob([bytes], { type: 'application/json' });
  return bytes;
}

try {
  for (const asBlob of [false, true]) {
    for (let round = 0; round < 40; round++) {
      const results = await Promise.allSettled([
        uploadBytes(target, payload(`short ${round}`, asBlob), { contentType: 'application/json' }),
        uploadBytes(target, payload(`a much longer chunk description ${round}`, asBlob), { contentType: 'application/json' }),
        uploadBytes(target, payload(`mid ${round} size`, asBlob), { contentType: 'application/json' }),
      ]);
      const rejected = results.filter(result => result.status === 'rejected');
      assert.deepEqual(rejected.map(result => String((result as PromiseRejectedResult).reason)), []);
      const metadata = await persistence.storage.getMetadata(path, 'pyric-default');
      const blob = await persistence.storage.getBlob(path, 'pyric-default');
      assert.equal(metadata?.size, blob?.size);
    }
  }
  assert.equal(persistence.status().state, 'healthy');
} finally { persistence.close(); }

console.log('Storage upload race passed');
