import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { installStorageBackend, replaceStorageRules } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { uploadTokenOf } from '../../../src/serve/worker/host/storage.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from '../../../src/serve/worker/client/storage.js';

// The production observations, read from the conformance package beside the cli build.
function observation(name: string): Record<string, unknown> {
  const file = new URL(`../../../src/../../conformance/observations/storage/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

const root = process.argv[2];
const bucket = 'pyric-default';
const SESSION = 'session-token-for-the-page';

const persistence = await createHostedPersistence(join(root, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{rest=**} { allow read, write: if true; }
  }
}`);
const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'download-url-oracle', subs: new Map(), storageByteRoute: true };
const route = createStorageByteRoute({ storage: persistence.storage, sessionToken: SESSION, uploadToken: id => uploadTokenOf(ctx, id) });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void route(request, response, url).then(handled => { if (!handled) response.writeHead(404).end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

let clientPort: ClientPort;
const hostPort: PortLike = { postMessage(message: unknown) { queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message }))); } };
clientPort = {
  onmessage: null, start() {}, close() {},
  postMessage(message: unknown) { void handleMessage(ctx, hostPort, message as InboundMessage); },
  byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
};
wirePort(clientPort);
const storage = getStorage({ __kind: 'client-db', port: clientPort } as never);

try {
  // storage-upload-bytes-roundtrip: the probe's payload, uploaded, then fetched by its download URL.
  {
    const produced = observation('storage-upload-bytes-roundtrip');
    const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63, 0x21]);
    assert.equal(payload.byteLength, produced.payloadLen);
    const target = ref(storage, 'pyric_oracle/upload-bytes/payload.bin');
    await uploadBytes(target, payload);
    const url = await getDownloadURL(target);
    // No header: the URL carries its own authority, as production's does.
    const response = await fetch(url);
    assert.equal(response.ok, produced.downloadOk);
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(body.byteLength, produced.bodyLen);
    assert.equal(Buffer.from(body).equals(Buffer.from(payload)), produced.bytesMatch);
    // Production's URL is https on Google Cloud Storage's host. The host's is http on
    // its own origin, with production's /v0/b/<bucket>/o/<path> form and a download token.
    assert.equal(produced.urlIsHttps, true);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'http:');
    assert.equal(parsed.origin, base);
    assert.equal(parsed.pathname, `/__pyric/storage/v0/b/${bucket}/o/${encodeURIComponent('pyric_oracle/upload-bytes/payload.bin')}`);
    assert.equal(parsed.searchParams.get('alt'), 'media');
    assert.match(parsed.searchParams.get('token') ?? '', /^[0-9a-f-]{36}$/);
  }

  // storage-delete-then-get-throws: getDownloadURL after a delete throws the production code.
  {
    const produced = observation('storage-delete-then-get-throws');
    const target = ref(storage, 'pyric_oracle/delete-then-get/soon-gone.bin');
    await uploadBytes(target, new Uint8Array([1, 2, 3]));
    await deleteObject(target);
    let code: string | undefined;
    try { await getDownloadURL(target); } catch (error) { code = (error as { code?: string }).code; }
    assert.equal(code !== undefined, produced.getUrlThrew);
    assert.equal(code, produced.code);
  }
} finally {
  server.close();
  sandbox.dispose();
  persistence.close();
}

console.log('Download URL oracle replay passed');
