// A server process saves an object with metadata.firebaseStorageDownloadTokens
// through firebase-admin. The download URL carrying that token serves the
// bytes to the browser; any other token is refused. A resumable upload session
// gives a URL on the host's byte route.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface ServerReport {
  bucket: string;
  downloadUrl: string;
  wrongTokenUrl: string;
  typeofCreateResumableUpload: string;
  createResumableUpload?: string;
  createResumableUploadError?: string;
  statuses: Record<'token' | 'wrong' | 'none', number>;
}

declare function download(url: string): Promise<{ status: number; text: string }>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const report = await app.step('the server saves public/hello.txt with a download token', async () => {
    const result = await app.serverScript('server.mjs', [host.url], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
    const line = result.output.trim().split('\n').findLast((text) => text.startsWith('{'));
    assert.ok(line, 'server.mjs printed no JSON report');
    return JSON.parse(line) as ServerReport;
  });

  await app.step('the browser downloads the bytes through the token URL', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'download' in window);
    assert.deepEqual(await page.evaluate((url) => download(url), report.downloadUrl), { status: 200, text: 'hello' });
    app.expectHostError(/^403 GET \/__pyric\/storage\/.*token=wrong$/);
    const wrong = await page.evaluate((url) => download(url), report.wrongTokenUrl);
    assert.equal(wrong.status, 403);
  });

  await app.step('the host serves the token URL to the server and refuses other tokens', () => {
    assert.deepEqual(report.statuses, { token: 200, wrong: 403, none: 403 });
  });

  await app.step('createResumableUpload gives a session URL on the byte route', () => {
    assert.equal(report.typeofCreateResumableUpload, 'function');
    assert.equal(report.createResumableUploadError, undefined);
    assert.match(report.createResumableUpload ?? '', /^http:\/\/127\.0\.0\.1:\d+\/__pyric\/storage\/v0\/b\/demo-app\.appspot\.com\/o\?/);
  });
});
