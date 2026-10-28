// In the default sandbox AI mode, firebase/app-check is Pyric's mirror: an app
// that calls initializeAppCheck on its first run gets a working handle and
// tokens shaped like production's, with no reCAPTCHA or App Check request
// leaving the browser. A server that initializes firebase-admin the usual
// way, with only `cert(serviceAccount)`, finds its project in the service
// account's project_id and verifies the page's token (#1294).
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function runAppCheck(): Promise<Record<string, unknown>>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const external: string[] = [];
  await app.step('record any request to reCAPTCHA or App Check', async () => {
    const context = await app.browser();
    for (const pattern of ['https://www.google.com/recaptcha/**', 'https://www.gstatic.com/**', 'https://firebaseappcheck.googleapis.com/**']) {
      await context.route(pattern, (route) => {
        external.push(route.request().url());
        return route.abort();
      });
    }
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runAppCheck' in window);
    return page;
  });

  await app.step('initializeAppCheck, getToken, getLimitedUseToken, and onTokenChanged work', async () => {
    const result = await page.evaluate(() => runAppCheck());
    assert.deepEqual(result, {
      segments: 3,
      cached: true,
      limitedDiffers: true,
      sub: '1:123456789012:web:abcdef0123456789',
      aud: ['projects/123456789012', 'projects/my-real-project'],
      iss: 'https://firebaseappcheck.googleapis.com/123456789012',
      ttl: 3600,
      listenerSawFirst: true,
      twice: 'appCheck/already-initialized',
    });
  });

  await app.step('no request left the browser for reCAPTCHA or App Check', () => {
    assert.deepEqual(external, []);
  });

  await app.step('a server initialized with only cert(serviceAccount) verifies the page token', async () => {
    const token = await page.evaluate(() => (window as unknown as { appCheckToken: string }).appCheckToken);
    const { output } = await app.serverScript('admin-server.mjs', [token], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
      timeoutMs: 30_000,
    });
    const line = output.match(/^verify (.*)$/m);
    assert.ok(line, `no verify line in:\n${output}`);
    assert.deepEqual(JSON.parse(line[1]), {
      ok: true,
      appId: '1:123456789012:web:abcdef0123456789',
      aud: ['projects/123456789012', 'projects/my-real-project'],
      options: {},
    });
  });
});
