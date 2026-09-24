import assert from 'node:assert/strict';
import { once } from 'node:events';
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
import {
  getBlob, getBytes, getDownloadURL, getMetadata, getStorage, ref, uploadBytes, uploadBytesResumable,
} from '../../../src/serve/worker/client/storage.js';

const root = process.argv[2];
const MiB = 1024 * 1024;
const bucket = 'pyric-default';
const SESSION = 'session-token-for-the-page';

const persistence = await createHostedPersistence(join(root, 'project'));
const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
installStorageBackend(sandbox, persistence.storage);
await replaceStorageRules(sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Rules grant when any match allows, so private/ is simply never matched.
    match /media/{rest=**} { allow read, write: if true; }
    match /notes/{rest=**} { allow read, write: if true; }
  }
}`);
const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: 'web-byte-route', subs: new Map() };

// The host's byte route, counting what reaches it.
const requests: string[] = [];
const route = createStorageByteRoute({ storage: persistence.storage, sessionToken: SESSION, uploadToken: id => uploadTokenOf(ctx, id) });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  requests.push(`${request.method} ${request.headers['content-range'] ?? ''}`.trim());
  void route(request, response, url).then(handled => { if (!handled) response.writeHead(404).end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

/** A page's port to the host, which advertised the byte route. */
function hostedPort(ops: string[]): ClientPort {
  let clientPort: ClientPort;
  const hostPort: PortLike = { postMessage(message: unknown) { queueMicrotask(() => clientPort.onmessage?.(new MessageEvent('message', { data: message }))); } };
  clientPort = {
    onmessage: null, start() {}, close() {},
    postMessage(message: unknown) {
      const inbound = message as InboundMessage;
      if (inbound.t === 'op') ops.push(inbound.method);
      void handleMessage(ctx, hostPort, inbound);
    },
    byteRoute: { baseUrl: base, sessionToken: async () => SESSION },
  };
  wirePort(clientPort);
  return clientPort;
}

const ops: string[] = [];
const storage = getStorage({ __kind: 'client-db', port: hostedPort(ops) } as never);
const patterned = (size: number, seed: number) => new Uint8Array(size).map((_, index) => (index * seed) % 251);
const same = (left: ArrayBuffer | Uint8Array, right: Uint8Array) => Buffer.from(left instanceof Uint8Array ? left : new Uint8Array(left)).equals(Buffer.from(right));

try {
  // Uploads send bytes over the route: rules and the commit over RPC, bytes by PUT.
  {
    const bytes = patterned(10 * MiB, 7);
    ops.length = 0; requests.length = 0;
    const result = await uploadBytes(ref(storage, 'media/take.wav'), bytes, { contentType: 'audio/wav' });
    assert.equal(result.metadata.size, bytes.byteLength);
    assert.deepEqual(ops, ['storage.beginUpload', 'storage.finishUpload']);
    assert.deepEqual(requests.map(request => request.split(' ')[0]), ['PUT', 'PUT', 'PUT']);
    const small = new TextEncoder().encode('a short note');
    ops.length = 0;
    await uploadBytes(ref(storage, 'notes/note.txt'), small, { contentType: 'text/plain' });
    assert.deepEqual(ops, ['storage.beginUpload', 'storage.finishUpload'], 'a small object takes the route too');
  }

  // Reads check rules over RPC, then GET the bytes.
  {
    ops.length = 0; requests.length = 0;
    const bytes = await getBytes(ref(storage, 'media/take.wav'));
    assert.ok(same(bytes, patterned(10 * MiB, 7)));
    const blob = await getBlob(ref(storage, 'notes/note.txt'));
    assert.equal(blob.type, 'text/plain');
    assert.equal(await blob.text(), 'a short note');
    assert.deepEqual(ops, ['storage.getMetadata', 'storage.getMetadata']);
    assert.deepEqual(requests, ['GET', 'GET']);
  }

  // Rules that deny a read refuse it before any byte is requested.
  {
    await persistence.storage.put('private/secret.txt', new Blob(['secret'], { type: 'text/plain' }), {
      bucket, fullPath: 'private/secret.txt', name: 'secret.txt', size: 6, generation: '1', metageneration: '1',
      timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'text/plain',
    });
    requests.length = 0;
    await assert.rejects(getBytes(ref(storage, 'private/secret.txt')), (error: { code?: string }) => error.code === 'storage/unauthorized');
    assert.deepEqual(requests, []);
  }

  // getDownloadURL returns an HTTP URL whose token is kept in the object's metadata.
  {
    const url = await getDownloadURL(ref(storage, 'media/take.wav'));
    const parsed = new URL(url);
    assert.equal(parsed.origin, base);
    assert.equal(parsed.pathname, `/__pyric/storage/v0/b/${bucket}/o/${encodeURIComponent('media/take.wav')}`);
    assert.equal(parsed.searchParams.get('alt'), 'media');
    const token = parsed.searchParams.get('token');
    assert.match(token ?? '', /^[0-9a-f-]{36}$/);
    const metadata = await getMetadata(ref(storage, 'media/take.wav'));
    assert.equal((metadata as { downloadTokens?: string }).downloadTokens, token);
    assert.equal(await getDownloadURL(ref(storage, 'media/take.wav')), url, 'the token persists');
    // The URL carries its own authority: no session token, no headers.
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.ok(same(await response.arrayBuffer(), patterned(10 * MiB, 7)));
    // Removing the token from the metadata revokes the URL.
    const stored = await persistence.storage.getMetadata('media/take.wav', bucket);
    const { downloadTokens: _removed, ...rest } = stored!;
    await persistence.storage.putMetadata('media/take.wav', { ...rest, metageneration: String(Number(stored!.metageneration) + 1) }, bucket);
    assert.equal((await fetch(url)).status, 403);
    assert.notEqual(await getDownloadURL(ref(storage, 'media/take.wav')), url, 'a new URL gets a new token');
  }

  // uploadBytesResumable reports progress as each slice lands.
  {
    const bytes = patterned(12 * MiB, 11);
    const progress: number[] = [];
    const task = uploadBytesResumable(ref(storage, 'media/long.wav'), bytes, { contentType: 'audio/wav' });
    task.on('state_changed', snapshot => { progress.push(snapshot.bytesTransferred); });
    const done = await task;
    assert.equal(done.state, 'success');
    assert.equal(done.metadata.size, bytes.byteLength);
    const running = progress.filter(value => value > 0 && value < bytes.byteLength);
    assert.ok(running.length >= 2, `progress: ${progress.join(', ')}`);
    assert.deepEqual([...running].sort((left, right) => left - right), running, 'progress only grows');
    assert.ok(same(await getBytes(ref(storage, 'media/long.wav')), bytes));
  }

  // Pausing stops sending; resuming asks the host where it got to and continues.
  {
    const bytes = patterned(12 * MiB, 13);
    const task = uploadBytesResumable(ref(storage, 'media/paused.wav'), bytes);
    const paused = new Promise<void>(resolve => {
      const stop = task.on('state_changed', snapshot => {
        const partWay = snapshot.bytesTransferred > 0 && snapshot.bytesTransferred < bytes.byteLength;
        if (partWay && snapshot.state === 'running') { task.pause(); stop(); resolve(); }
      });
    });
    await paused;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(task.snapshot.state, 'paused');
    const held = task.snapshot.bytesTransferred;
    requests.length = 0;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(requests, [], 'nothing is sent while paused');
    assert.equal(task.snapshot.bytesTransferred, held);
    task.resume();
    const done = await task;
    assert.equal(done.state, 'success');
    assert.equal(requests[0], `PUT bytes */${bytes.byteLength}`, 'resuming first asks for the offset');
    assert.ok(same(await getBytes(ref(storage, 'media/paused.wav')), bytes));
  }

  // Canceling aborts the upload on the host; no object is written.
  {
    const bytes = patterned(12 * MiB, 17);
    ops.length = 0;
    const task = uploadBytesResumable(ref(storage, 'media/canceled.wav'), bytes);
    await new Promise<void>(resolve => {
      const stop = task.on('state_changed', snapshot => {
        if (snapshot.bytesTransferred > 0 && snapshot.state === 'running') { task.cancel(); stop(); resolve(); }
      });
    });
    await assert.rejects(task, (error: { code?: string }) => error.code === 'storage/canceled');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(ops.includes('storage.abortUpload'), `ops: ${ops.join(', ')}`);
    assert.equal(await persistence.storage.getMetadata('media/canceled.wav', bucket), undefined);
  }
} finally {
  server.close();
  sandbox.dispose();
  persistence.close();
}

console.log('Web byte route passed');
