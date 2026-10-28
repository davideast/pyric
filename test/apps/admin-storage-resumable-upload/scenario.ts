// A server-issued upload through firebase-admin against the hosted sandbox:
// the server opens a resumable upload session in a named staging bucket, a
// page on the app's own origin PUTs the bytes to the session URL, and the
// server validates the staged object, copies it into the default bucket with
// a Firebase download token, and stores the download URL the page renders.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scenario } from '../driver.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

interface SessionReport { defaultBucket: string; stagingBucket?: string; sessionUrl?: string; error?: string }
interface PublishReport {
  error?: string;
  staged?: { exists: boolean; bucket: string; contentType: string; size: string; metadata: Record<string, string>; isPng: boolean };
  stagedPathInDefaultBucket?: boolean;
  published?: { bucket: string; contentType: string; metadata: Record<string, string> };
  stagedAfterDelete?: boolean;
  downloadUrl?: string;
  token?: string;
}

declare function clientBucket(): string;
declare function render(url: string): Promise<{ status: number; contentType: string | null; bytes: number[]; width: number }>;

function lastJson<T>(output: string, script: string): T {
  const line = output.trim().split('\n').findLast((text) => text.startsWith('{'));
  assert.ok(line, `${script} printed no JSON report`);
  return JSON.parse(line) as T;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  // The app's frontend runs on its own origin, as an app server's pages do.
  const frontend = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>app</title>');
  });
  frontend.listen(0);
  await once(frontend, 'listening');
  const appOrigin = `http://localhost:${(frontend.address() as AddressInfo).port}`;
  frontend.unref();

  const session = await app.step('the server opens an upload session in the staging bucket', async () => {
    const result = await app.serverScript('create-session.mjs', [appOrigin], { env });
    return lastJson<SessionReport>(result.output, 'create-session.mjs');
  });

  await app.step('the default bucket is the configured storageBucket, as the page SDK names it', async () => {
    assert.equal(session.defaultBucket, 'demo-app.appspot.com');
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'clientBucket' in window);
    assert.equal(await page.evaluate(() => clientBucket()), session.defaultBucket);
  });

  await app.step('createResumableUpload in a named bucket gives a session URL', () => {
    assert.equal(session.error, undefined, `create-session.mjs failed: ${session.error}`);
    assert.equal(session.stagingBucket, 'demo-app-upload-staging');
    assert.match(session.sessionUrl ?? '', new RegExp(`^${host.url.replaceAll('.', '\\.')}/__pyric/storage/v0/b/demo-app-upload-staging/o\\?`));
  });

  await app.step('the browser PUTs the bytes to the session URL from the app origin', async () => {
    const page = await app.page(`${appOrigin}/`);
    const put = await page.evaluate(async ({ url, bytes }) => {
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(bytes) });
      return { status: response.status, body: await response.text() };
    }, { url: session.sessionUrl!, bytes: [...PNG] });
    assert.equal(put.status, 200, `PUT answered ${put.status}: ${put.body}`);
  });

  const published = await app.step('the server validates the staged object and publishes it to the default bucket', async () => {
    const result = await app.serverScript('publish-upload.mjs', [host.url], { env });
    const report = lastJson<PublishReport>(result.output, 'publish-upload.mjs');
    assert.equal(report.error, undefined, `publish-upload.mjs failed: ${report.error}`);
    assert.deepEqual(report.staged, {
      exists: true,
      bucket: 'demo-app-upload-staging',
      contentType: 'image/png',
      size: String(PNG.byteLength),
      metadata: { uid: 'u1' },
      isPng: true,
    });
    assert.equal(report.stagedPathInDefaultBucket, false);
    assert.deepEqual(report.published, {
      bucket: 'demo-app.appspot.com',
      contentType: 'image/png',
      metadata: { uid: 'u1', firebaseStorageDownloadTokens: report.token },
    });
    assert.equal(report.stagedAfterDelete, false);
    return report;
  });

  await app.step('the page renders the bytes from the stored download URL', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'render' in window);
    const shown = await page.evaluate((url) => render(url), published.downloadUrl!);
    assert.deepEqual(shown, { status: 200, contentType: 'image/png', bytes: [...PNG], width: 1 });
  });
});
