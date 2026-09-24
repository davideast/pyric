import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
// pyric-admin is not linked into node_modules; the runner rewrites ../../../src/ to the cli build, beside pyric-admin's.
import { deleteApp, initializeApp } from '../../../src/../../pyric-admin/dist/app/index.js';
import { getStorage } from '../../../src/../../pyric-admin/dist/storage/index.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';

// The host compares project directories by their real path.
const directory = realpathSync(process.argv[2]);
const MiB = 1024 * 1024;
const SESSION = 'session-token-for-node-clients';
const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // The dev server's namespace hands this process the session token, as init.json does.
  if (url.pathname === '/__pyric/init.json') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionToken: SESSION }));
    return;
  }
  void mount.handler(request, response, url).then(handled => { if (!handled) response.writeHead(404).end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, sessionToken: SESSION };
const patterned = (size: number, seed: number) => Buffer.from(new Uint8Array(size).map((_, index) => (index * seed) % 251));

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

await mount.startHostedSandbox(payload, base);
mount.attachHost({ servers: [server], projectDir: directory, origin: () => ({ host: '127.0.0.1', port: address.port }) });
const remote = await connectRemoteSandbox({ url: base });
const app = initializeApp({ sandbox: remote }, 'node-byte-route');
try {
  const bucket = getStorage(app).bucket();

  // pyric-admin saves and downloads over the route; the host refuses frames, so success means HTTP.
  const take = patterned(12 * MiB, 7);
  await bucket.file('media/take.wav').save(take, { contentType: 'audio/wav' });
  const [whole] = await bucket.file('media/take.wav').download();
  assert.ok(whole.equals(take));
  const [span] = await bucket.file('media/take.wav').download({ start: 5_000_000, end: 5_000_009 });
  // Buffer comparisons fail fast; deepEqual on megabytes renders a diff for minutes.
  assert.ok(span.equals(take.subarray(5_000_000, 5_000_010)), `download range returned ${span.length} bytes`);
  const small = Buffer.from('a short note');
  await bucket.file('notes/note.txt').save(small, { contentType: 'text/plain' });
  assert.equal((await bucket.file('notes/note.txt').download())[0].toString(), 'a short note');

  // Streams.
  const streamed = await collect(bucket.file('media/take.wav').createReadStream({ start: 11 * MiB, end: 11 * MiB + 99 }));
  assert.ok(streamed.equals(take.subarray(11 * MiB, 11 * MiB + 100)), `stream range returned ${streamed.length} bytes`);
  const written = patterned(9 * MiB + 3, 11);
  await pipeline(Readable.from([written.subarray(0, 3 * MiB), written.subarray(3 * MiB)]), bucket.file('media/written.wav').createWriteStream({ contentType: 'audio/wav' }));
  assert.ok((await bucket.file('media/written.wav').download())[0].equals(written));

  // The Node remote client has no 8 MiB cap on the route.
  const large = patterned(20 * MiB, 13);
  await remote.storage.putBytes('media/large.bin', large, { contentType: 'application/octet-stream' });
  assert.ok(Buffer.from(await remote.storage.getBytes('media/large.bin')).equals(large));

  // The Node host refuses Storage bytes sent as frames.
  await assert.rejects(
    remote.channel.op({ method: 'storage.putBytes', path: 'media/framed.bin', dataB64: 'AAAA', actAs: { mode: 'admin' } }),
    (error: Error & { code?: string }) => error.code === 'failed-precondition' && /byte route/.test(error.message),
  );
  await assert.rejects(
    remote.channel.op({ method: 'storage.getBytes', path: 'notes/note.txt', actAs: { mode: 'admin' } }),
    (error: Error & { code?: string }) => error.code === 'failed-precondition',
  );
} finally {
  await deleteApp(app);
  await remote.close?.();
  await mount.close();
  server.close();
}

console.log('Node byte route passed');
