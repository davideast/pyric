import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
// pyric-admin is not linked into node_modules; the runner rewrites ../../../src/ to the cli build, beside pyric-admin's.
import { deleteApp, initializeApp } from '../../../src/../../pyric-admin/dist/app/index.js';
import { getDownloadURL, getStorage } from '../../../src/../../pyric-admin/dist/storage/index.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';

// The production capture, read from the conformance package beside the cli build.
const production = JSON.parse(readFileSync(
  new URL('../../../src/../../conformance/observations/storage-admin/admin-storage-metadata-download-url.json', import.meta.url),
  'utf8',
)).behavior;

const directory = realpathSync(process.argv[2]);
const SESSION = 'session-token-for-admin-metadata';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BYTES = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
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
const app = initializeApp({ sandbox: remote }, 'admin-metadata-oracle');
const bucket = getStorage(app).bucket();
const path = 'pyric_oracle/admin_storage/take one.wav';

async function saved() {
  const file = bucket.file(path);
  await file.save(BYTES, { contentType: 'audio/wav' });
  return file;
}
const has = (value: object | undefined, key: string) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

try {
  // storage-admin#1 and #2: custom metadata, and null removing a key.
  {
    const file = await saved();
    const [afterSave] = await file.getMetadata();
    assert.deepEqual(afterSave.metadata ?? null, production.afterSave.customMetadata);
    const [set] = await file.setMetadata({ metadata: { note: 'first' } });
    assert.equal(set.metadata !== undefined, production.setMetadataResolvesWithMetadata);
    const [afterSet] = await file.getMetadata();
    assert.equal(afterSet.metadata?.note, production.afterSet.customMetadata.note);
    assert.equal(Number(afterSet.metageneration) > Number(afterSave.metageneration), production.afterSet.metagenerationAdvanced);
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: 'token-kept' } });
    await file.setMetadata({ metadata: { note: null } });
    const [afterNull] = await file.getMetadata();
    assert.equal(!has(afterNull.metadata, 'note'), production.nullRemovesKey.noteRemoved);
    assert.equal(afterNull.metadata?.firebaseStorageDownloadTokens === 'token-kept', production.nullRemovesKey.tokenKept);
    await file.delete();
  }

  // storage-admin#3 and #4: minting, and the URL's form.
  const file = await saved();
  const [before] = await file.getMetadata();
  assert.equal(Boolean(before.metadata?.firebaseStorageDownloadTokens), production.afterSave.hasDownloadTokens);
  const url = await getDownloadURL(file);
  const [after] = await file.getMetadata();
  const token = after.metadata?.firebaseStorageDownloadTokens;
  assert.equal(typeof token === 'string' && token.length > 0, production.getDownloadURLWithoutToken.mintsTokenIntoMetadata);
  assert.equal(UUID.test(String(token)), production.getDownloadURLWithoutToken.mintedTokenIsUuid);
  const parsed = new URL(url);
  // Production's origin is https://firebasestorage.googleapis.com; the host serves its own, under /__pyric/storage.
  assert.equal(parsed.origin, base);
  assert.equal(parsed.pathname.replace(/^\/__pyric\/storage/, '').replace(/\/b\/[^/]+\/o\/[^/]+$/, '/b/<bucket>/o/<encoded path>'), production.downloadURL.pathForm);
  assert.equal(parsed.searchParams.get('alt'), production.downloadURL.alt);
  assert.deepEqual([...parsed.searchParams.keys()].sort(), production.downloadURL.queryKeys);
  assert.equal(parsed.searchParams.get('token') === token, production.downloadURL.tokenEqualsStored);
  assert.equal(parsed.searchParams.get('token') === token, production.getDownloadURLWithoutToken.urlCarriesMintedToken);
  // What a client SDK reads: the token as downloadTokens, not a custom key.
  const clientView = await remote.channel.op({ method: 'storage.getMetadata', path, actAs: { mode: 'admin' } }) as { downloadTokens?: string; customMetadata?: Record<string, string> };
  assert.equal(clientView.downloadTokens === token, production.firebaseMetadataEndpoint.downloadTokensEqualsSet);
  assert.equal(has(clientView.customMetadata, 'firebaseStorageDownloadTokens'), production.firebaseMetadataEndpoint.metadataHasTokenKey);

  // storage-admin#6: an unauthenticated GET, and a Range GET.
  const whole = await fetch(url);
  assert.equal(whole.status, production.unauthenticatedGet.status);
  assert.equal(whole.headers.get('content-type'), production.unauthenticatedGet.contentType);
  assert.equal(Buffer.from(await whole.arrayBuffer()).equals(BYTES), production.unauthenticatedGet.bytesMatch);
  const ranged = await fetch(url, { headers: { range: 'bytes=2-5' } });
  assert.equal(ranged.status, production.rangeGet.status);
  assert.equal(ranged.headers.get('content-range'), production.rangeGet.contentRange);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).equals(BYTES.subarray(2, 6)), production.rangeGet.bytesMatch);

  // storage-admin#5: removing the token revokes the URL; the next call mints another.
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
  const [revoked] = await file.getMetadata();
  assert.equal(!has(revoked.metadata, 'firebaseStorageDownloadTokens'), production.revocation.tokenRemoved);
  assert.equal((await fetch(url)).status, production.revocation.revokedUrlStatus);
  const next = await getDownloadURL(file);
  assert.equal(new URL(next).searchParams.get('token') !== token, production.revocation.getDownloadURLAfterRevoke.mintsNewToken);
  assert.equal((await fetch(next)).status, production.revocation.getDownloadURLAfterRevoke.newUrlStatus);
} finally {
  await deleteApp(app);
  await remote.close?.();
  await mount.close();
  server.close();
}

console.log('Admin metadata oracle replay passed');
