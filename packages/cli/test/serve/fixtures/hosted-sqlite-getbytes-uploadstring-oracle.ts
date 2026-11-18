import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { getFirestore } from 'pyric/firestore';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { installStorageBackend, replaceStorageRules } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  getBytes,
  getMetadata,
  getStorage,
  ref,
  uploadBytes,
  uploadString,
} from '../../../src/serve/worker/client/storage.js';

function observation(name: string): Record<string, unknown> {
  const file = new URL(`../../../src/../../conformance/observations/storage/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

function decodeValidUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const rawRootArg = process.argv[2] ?? '.';
const SESSION = 'session-token-s8-oracle';

const persistence = await createHostedPersistence(join(rawRootArg, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{rest=**} { allow read, write: if true; }
  }
}`);

const ctx: HostCtx = {
  sandbox,
  db: getFirestore(sandbox),
  instanceId: 's8-getbytes-uploadstring-oracle',
  subs: new Map(),
  storageByteRoute: true,
};
const route = createStorageByteRoute({
  storage: persistence.storage,
  sessionToken: SESSION,
  uploadToken: (id) => uploadTokenOf(ctx, id),
});
const server = createServer((request, response) => {
  const rawUrl = request.url ?? '/';
  const parsedUrl = new URL(rawUrl, 'http://localhost');
  void route(request, response, parsedUrl).then((handled) => {
    if (!handled) {
      response.writeHead(404).end();
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

let clientPort: ClientPort;
const hostPort: PortLike = {
  postMessage(message: unknown) {
    queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message })));
  },
};
clientPort = {
  onmessage: null,
  start() {},
  close() {},
  postMessage(message: unknown) {
    void handleMessage(ctx, hostPort, message as InboundMessage);
  },
  byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
};
wirePort(clientPort);
const storage = getStorage({ __kind: 'client-db', port: clientPort } as never);

try {
  // client-storage-getbytes-root-ref
  {
    const produced = observation('client-storage-getbytes-root-ref');
    const rootRef = ref(storage);
    assert.equal(rootRef.fullPath, produced.rootFullPath);
    assert.equal(rootRef.name, produced.rootName);
    let threwSynchronously = false;
    let code: string | undefined;
    try {
      void getBytes(rootRef);
    } catch (err) {
      threwSynchronously = true;
      code = (err as { code?: string }).code;
    }
    assert.equal(threwSynchronously, produced.threwSynchronously);
    assert.equal(code, produced.code);
  }

  // client-storage-uploadstring-malformed-data-url
  {
    const produced = observation('client-storage-uploadstring-malformed-data-url');
    const itemRef = ref(storage, 'pyric_oracle/uploadstring/bad.txt');
    const cases = [
      { input: 'plain-text,hello', expected: produced.missingDataPrefix as Record<string, unknown> },
      { input: 'data:text/plain;base64', expected: produced.missingComma as Record<string, unknown> },
      { input: 'data:text/plain,%ZZ', expected: produced.invalidPercentEncoding as Record<string, unknown> },
    ];
    for (const entry of cases) {
      let threwSynchronously = false;
      let code: string | undefined;
      let errorName: string | undefined;
      try {
        void uploadString(itemRef, entry.input, 'data_url');
      } catch (err) {
        threwSynchronously = true;
        code = (err as { code?: string }).code;
        errorName = (err as { name?: string }).name;
      }
      assert.equal(threwSynchronously, entry.expected.threwSynchronously);
      assert.equal(code, entry.expected.code);
      assert.equal(errorName, entry.expected.errorName);
    }
  }

  // storage-getbytes-roundtrip-and-cap
  {
    const produced = observation('storage-getbytes-roundtrip-and-cap');
    const capRef = ref(storage, 'pyric_oracle/getbytes-cap/payload.bin');
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    await uploadBytes(capRef, payload, { contentType: 'application/octet-stream' });

    async function readCap(cap?: number) {
      let buf: ArrayBuffer;
      if (cap === undefined) {
        buf = await getBytes(capRef);
      } else {
        buf = await getBytes(capRef, cap);
      }
      return {
        threw: false,
        code: null,
        errorName: null,
        isFirebaseError: false,
        isArrayBuffer: buf instanceof ArrayBuffer,
        byteLength: buf.byteLength,
        bytes: [...new Uint8Array(buf)],
      };
    }

    assert.deepEqual(await readCap(), produced.unbounded);
    assert.deepEqual(await readCap(6), produced.truncatedMax6);
    assert.deepEqual(await readCap(16), produced.exactMax16);
    assert.deepEqual(await readCap(32), produced.aboveMax32);
  }

  // storage-uploadstring-data-url-variants
  {
    const produced = observation('storage-uploadstring-data-url-variants');
    async function runDataUrl(subpath: string, dataUrl: string, metadata?: { contentType: string }) {
      const targetRef = ref(storage, `pyric_oracle/${subpath}`);
      const uploaded = await uploadString(targetRef, dataUrl, 'data_url', metadata);
      const fetched = await getMetadata(targetRef);
      const bytes = new Uint8Array(await getBytes(targetRef));
      return {
        size: uploaded.metadata.size,
        uploadedContentType: uploaded.metadata.contentType ?? null,
        fetchedContentType: fetched.contentType ?? null,
        decodedBytes: [...bytes],
        decodedUtf8: new TextDecoder('utf-8').decode(bytes),
      };
    }
    assert.deepEqual(
      await runDataUrl('data-url/json.json', 'data:application/json;base64,eyJvayI6dHJ1ZX0='),
      produced.base64JsonDataUrl,
    );
    assert.deepEqual(
      await runDataUrl('data-url/plain.txt', 'data:text/plain,hello%20world%21'),
      produced.percentEncodedDataUrl,
    );
    assert.deepEqual(
      await runDataUrl('data-url/override.csv', 'data:text/plain;base64,YSwx', { contentType: 'text/csv' }),
      produced.callerContentTypeOverride,
    );
  }

  // storage-uploadstring-raw-and-base64
  {
    const produced = observation('storage-uploadstring-raw-and-base64');
    async function runRawOrBase64(subpath: string, value: string, format?: 'raw' | 'base64') {
      const targetRef = ref(storage, `pyric_oracle/${subpath}`);
      let uploaded;
      if (format === undefined) {
        uploaded = await uploadString(targetRef, value);
      } else {
        uploaded = await uploadString(targetRef, value, format);
      }
      const fetched = await getMetadata(targetRef);
      const bytes = new Uint8Array(await getBytes(targetRef));
      return {
        size: uploaded.metadata.size,
        uploadedContentType: uploaded.metadata.contentType ?? null,
        fetchedContentType: fetched.contentType ?? null,
        decodedBytes: [...bytes],
        decodedUtf8: decodeValidUtf8OrNull(bytes),
      };
    }
    const defaultRaw = await runRawOrBase64('uploadstring/default-raw.txt', 'Hello, UTF-8!');
    const explicitRaw = await runRawOrBase64('uploadstring/explicit-raw.txt', 'Explicit raw line', 'raw');
    const standardBase64 = await runRawOrBase64('uploadstring/standard-b64.bin', 'AQID/w==', 'base64');

    assert.deepEqual(defaultRaw, produced.defaultRaw);
    assert.deepEqual(explicitRaw, produced.explicitRaw);
    assert.deepEqual(standardBase64, produced.standardBase64);
  }
} finally {
  server.close();
  sandbox.dispose();
  persistence.close();
}

console.log('GetBytes and uploadString oracle replay passed');
