import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { createStorageByteRoute } from '../../../src/serve/hosted/storage-byte-route.js';

const root = process.argv[2];
const MiB = 1024 * 1024;
const bucket = 'pyric-default';
const SESSION = 'session-token-for-the-route';
const metadata = (fullPath: string, size: number, contentType: string, extra: Record<string, unknown> = {}) => ({
  bucket, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1), size, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType, ...extra,
});

const directory = join(root, 'hosted');
const database = await openHostedDatabase(directory);
const storage = database.storage;
const take = new Uint8Array(1 * MiB).map((_, index) => (index * 7) % 251);
await storage.put('media/take one.wav', new Blob([take], { type: 'audio/wav' }),
  metadata('media/take one.wav', take.byteLength, 'audio/wav', { downloadTokens: 'token-a,token-b' }));

// A 300 MiB object as a sparse file, so serving it whole would show in resident memory.
const LARGE = 300 * MiB;
const largeHash = 'f'.repeat(64);
mkdirSync(join(directory, 'objects', 'ff'), { recursive: true });
writeFileSync(join(directory, 'objects', 'ff', largeHash), '');
truncateSync(join(directory, 'objects', 'ff', largeHash), LARGE);
const raw = new DatabaseSync(join(directory, 'state.sqlite'));
raw.prepare('INSERT INTO storage_objects (bucket, path, metadata, mime, sha256, size) VALUES (?, ?, ?, ?, ?, ?)')
  .run(bucket, 'media/long.wav', JSON.stringify(metadata('media/long.wav', LARGE, 'audio/wav')), 'audio/wav', largeHash, LARGE);
raw.close();

const uploadTokens = new Map<string, string>();
const route = createStorageByteRoute({ storage, sessionToken: SESSION, uploadToken: uploadId => uploadTokens.get(uploadId) });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void route(request, response, url).then(handled => {
    if (!handled) response.writeHead(404).end('not a byte route');
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const objectUrl = (path: string, query = 'alt=media') => `${base}/__pyric/storage/v0/b/${bucket}/o/${encodeURIComponent(path)}?${query}`;
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

try {
  // A GET with the session token serves the object with its own content type.
  const whole = await fetch(objectUrl('media/take one.wav'), { headers: { 'x-pyric-session-token': SESSION } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/wav');
  assert.equal(whole.headers.get('content-length'), String(take.byteLength));
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await bytesOf(whole)).equals(Buffer.from(take)));

  // The token may be the session token or one of the object's download tokens, in the query.
  assert.equal((await fetch(objectUrl('media/take one.wav', `alt=media&token=${SESSION}`))).status, 200);
  const byDownloadToken = await fetch(objectUrl('media/take one.wav', 'alt=media&token=token-b'));
  assert.equal(byDownloadToken.status, 200);
  assert.ok(Buffer.from(await bytesOf(byDownloadToken)).equals(Buffer.from(take)));
  assert.equal((await fetch(objectUrl('media/take one.wav'))).status, 403);
  assert.equal((await fetch(objectUrl('media/take one.wav', 'alt=media&token=token-c'))).status, 403);
  assert.equal((await fetch(objectUrl('media/missing.wav', `alt=media&token=${SESSION}`))).status, 404);

  // A read pinned to the generation its rules check saw refuses a newer object.
  assert.equal((await fetch(objectUrl('media/take one.wav', `alt=media&token=${SESSION}&generation=1`))).status, 200);
  assert.equal((await fetch(objectUrl('media/take one.wav', `alt=media&token=${SESSION}&generation=2`))).status, 412);

  // Ranges: a span, a suffix, and one past the end.
  const span = await fetch(objectUrl('media/take one.wav', 'alt=media&token=token-a'), { headers: { range: 'bytes=100-199' } });
  assert.equal(span.status, 206);
  assert.equal(span.headers.get('content-range'), `bytes 100-199/${take.byteLength}`);
  assert.equal(span.headers.get('content-length'), '100');
  assert.ok(Buffer.from(await bytesOf(span)).equals(Buffer.from(take.slice(100, 200))));
  const suffix = await fetch(objectUrl('media/take one.wav', 'alt=media&token=token-a'), { headers: { range: 'bytes=-10' } });
  assert.equal(suffix.status, 206);
  assert.ok(Buffer.from(await bytesOf(suffix)).equals(Buffer.from(take.slice(take.byteLength - 10))));
  const past = await fetch(objectUrl('media/take one.wav', 'alt=media&token=token-a'), { headers: { range: `bytes=${take.byteLength}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${take.byteLength}`);

  // Serving a 300 MiB object streams it: resident memory does not grow with the object.
  {
    const rssBefore = process.memoryUsage().rss;
    const response = await fetch(objectUrl('media/long.wav', `alt=media&token=${SESSION}`));
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) received += chunk.byteLength;
    const growth = process.memoryUsage().rss - rssBefore;
    assert.equal(received, LARGE);
    assert.ok(growth < 64 * MiB, `serving grew rss by ${(growth / MiB).toFixed(1)} MiB`);
  }

  // An upload is a PUT to its own URL with its own token, continued from the offset the host holds.
  {
    const bytes = new Uint8Array(3 * MiB + 17).map((_, index) => (index * 13) % 251);
    const uploadId = await storage.beginUpload(bucket, 'media/up.bin', bytes.byteLength, 'application/octet-stream');
    uploadTokens.set(uploadId, 'upload-token-1');
    const uploadUrl = (token: string) => `${base}/__pyric/storage/v0/b/${bucket}/o?name=${encodeURIComponent('media/up.bin')}&upload_id=${uploadId}&upload_token=${token}`;
    const total = bytes.byteLength;
    assert.equal((await fetch(uploadUrl('wrong'), { method: 'PUT', body: bytes.slice(0, 10) })).status, 403);
    assert.equal((await fetch(uploadUrl(SESSION), { method: 'PUT', body: bytes.slice(0, 10) })).status, 403, 'the session token does not stand in for an upload token');

    const empty = await fetch(uploadUrl('upload-token-1'), { method: 'PUT', headers: { 'content-range': `bytes */${total}` } });
    assert.equal(empty.status, 308);
    assert.equal(empty.headers.get('range'), null);

    const half = 1 * MiB + 5;
    const first = await fetch(uploadUrl('upload-token-1'), { method: 'PUT', headers: { 'content-range': `bytes 0-${half - 1}/${total}` }, body: bytes.slice(0, half) });
    assert.equal(first.status, 308);
    assert.equal(first.headers.get('range'), `bytes=0-${half - 1}`);
    const status = await fetch(uploadUrl('upload-token-1'), { method: 'PUT', headers: { 'content-range': `bytes */${total}` } });
    assert.equal(status.headers.get('range'), `bytes=0-${half - 1}`);

    const skipped = await fetch(uploadUrl('upload-token-1'), { method: 'PUT', headers: { 'content-range': `bytes ${half + 1}-${total - 1}/${total}` }, body: bytes.slice(half + 1) });
    assert.equal(skipped.status, 409);
    assert.equal(skipped.headers.get('range'), `bytes=0-${half - 1}`);

    const rest = await fetch(uploadUrl('upload-token-1'), { method: 'PUT', headers: { 'content-range': `bytes ${half}-${total - 1}/${total}` }, body: bytes.slice(half) });
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), { bytesReceived: total, size: total });
    const staged = await storage.readUpload(uploadId);
    assert.ok(Buffer.from(await staged.arrayBuffer()).equals(Buffer.from(bytes)));
    await storage.abortUpload(uploadId);
  }

  // A 256 MiB upload streams into staging: resident memory does not grow with the object.
  {
    const size = 256 * MiB;
    const uploadId = await storage.beginUpload(bucket, 'media/long-up.bin', size, 'application/octet-stream');
    uploadTokens.set(uploadId, 'upload-token-2');
    const chunk = new Uint8Array(MiB);
    const source = Readable.from((function* () { for (let sent = 0; sent < size; sent += MiB) yield chunk; })());
    const rssBefore = process.memoryUsage().rss;
    const response = await fetch(`${base}/__pyric/storage/v0/b/${bucket}/o?name=media%2Flong-up.bin&upload_id=${uploadId}&upload_token=upload-token-2`, {
      method: 'PUT', headers: { 'content-range': `bytes 0-${size - 1}/${size}` }, body: Readable.toWeb(source) as ReadableStream, duplex: 'half',
    } as RequestInit);
    const growth = process.memoryUsage().rss - rssBefore;
    assert.equal(response.status, 200);
    assert.ok(growth < 96 * MiB, `a ${size / MiB} MiB upload grew rss by ${(growth / MiB).toFixed(1)} MiB`);
    await storage.abortUpload(uploadId);
  }
} finally {
  server.close();
  database.close();
}

console.log('Byte route passed');
