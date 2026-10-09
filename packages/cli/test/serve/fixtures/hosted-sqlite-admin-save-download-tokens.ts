import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
// pyric-admin is not linked into node_modules; the runner rewrites ../../../src/ to the cli build, beside pyric-admin's.
import { deleteApp, initializeApp } from '../../../src/../../pyric-admin/dist/app/index.js';
import { getDownloadURL, getStorage } from '../../../src/../../pyric-admin/dist/storage/index.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';

const directory = realpathSync(process.argv[2]);
const SESSION = 'session-token-for-admin-save-tokens';
const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
await mount.startHostedSandbox({ rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, sessionToken: SESSION }, base);
mount.attachHost({ servers: [server], projectDir: directory, origin: () => ({ host: '127.0.0.1', port: address.port }) });
const remote = await connectRemoteSandbox({ url: base });
const app = initializeApp({ sandbox: remote }, 'admin-save-download-tokens');
const bucket = getStorage(app).bucket();
const has = (value: object | undefined, key: string) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const mediaUrl = (path: string, token?: string) =>
  `${base}/__pyric/storage/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media${token === undefined ? '' : `&token=${token}`}`;

try {
  // A server sets a download token at upload, as firebase-admin's save does.
  const path = 'public/hello.txt';
  const file = bucket.file(path);
  await file.save(Buffer.from('hello'), {
    resumable: false,
    metadata: { contentType: 'text/plain', metadata: { firebaseStorageDownloadTokens: 'tok-1', note: 'kept' } },
  });
  const [saved] = await file.getMetadata();
  assert.deepEqual(saved.metadata, { note: 'kept', firebaseStorageDownloadTokens: 'tok-1' });

  const granted = await fetch(mediaUrl(path, 'tok-1'));
  assert.equal(granted.status, 200);
  assert.equal(granted.headers.get('content-type'), 'text/plain');
  assert.equal(await granted.text(), 'hello');
  assert.equal((await fetch(mediaUrl(path, 'wrong'))).status, 403);
  assert.equal((await fetch(mediaUrl(path))).status, 403);

  // What a client SDK reads: the token as downloadTokens, not a custom key; its getDownloadURL carries it.
  const clientView = await remote.channel.op({ method: 'storage.getMetadata', path, actAs: { mode: 'admin' } }) as { downloadTokens?: string; customMetadata?: Record<string, string> };
  assert.equal(clientView.downloadTokens, 'tok-1');
  assert.deepEqual(clientView.customMetadata, { note: 'kept' });
  const clientUrl = await remote.channel.op({ method: 'storage.getDownloadURL', path, actAs: { mode: 'admin' } }) as { path: string };
  assert.equal(new URL(clientUrl.path, base).searchParams.get('token'), 'tok-1');
  assert.equal(new URL(await getDownloadURL(file)).searchParams.get('token'), 'tok-1');

  // Removing the token revokes the URL.
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
  const [revoked] = await file.getMetadata();
  assert.ok(!has(revoked.metadata, 'firebaseStorageDownloadTokens'));
  assert.equal((await fetch(mediaUrl(path, 'tok-1'))).status, 403);

  // createWriteStream sets the token the same way.
  const streamed = bucket.file('public/streamed.txt');
  await new Promise<void>((resolve, reject) => {
    const stream = streamed.createWriteStream({ metadata: { contentType: 'text/plain', metadata: { firebaseStorageDownloadTokens: 'tok-2' } } });
    stream.on('error', reject).on('finish', () => resolve());
    stream.end('streamed');
  });
  const streamedGet = await fetch(mediaUrl(streamed.name, 'tok-2'));
  assert.equal(streamedGet.status, 200);
  assert.equal(await streamedGet.text(), 'streamed');
  assert.deepEqual((await streamed.getMetadata())[0].metadata, { firebaseStorageDownloadTokens: 'tok-2' });
} finally {
  await deleteApp(app);
  await remote.close?.();
  await mount.close();
  server.close();
}

console.log('Admin save download tokens passed');
