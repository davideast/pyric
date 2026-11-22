// A provider sign-in through the hosted sandbox gives the user a default
// avatar. Production photoURL values are absolute, so an app can hand one to a
// blob-URL iframe, whose base cannot resolve a relative path. The page's
// user.photoURL, user.providerData[0].photoURL, auth-state snapshots, unified
// sandbox events, the ID token's picture claim, and firebase-admin's getUser
// must all carry the absolute URL on the page's origin.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface SignInReport {
  uid: string;
  photoURL: string | null;
  providerPhotoURL: string | null;
  authStatePhotoURL: string | null;
  authStateProviderPhotoURL: string | null;
  picture: string | null;
  topLoaded: boolean;
  iframe: { loaded: boolean; error: string | null };
}

interface SandboxEventsEnvelope {
  data?: {
    events?: Array<{
      service?: string;
      method?: string;
      path?: string;
      auth?: { token?: { picture?: string | null } } | null;
      resourceAfter?: { data?: { photoUrl?: string | null } };
    }>;
  };
}

declare function signIn(): Promise<SignInReport>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const origin = new URL(host.url).origin;
  const avatarPrefix = `${origin}/__pyric/assets/avatar/`;

  const report = await app.step('sign in with Google through the sandbox dialog', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'signIn' in window, undefined, { timeout: 30_000 });
    const result = page.evaluate(() => signIn());
    const dialog = page.locator('dialog[data-pyric-auth][open]');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('input[type="email"]').fill('david@example.com');
    await dialog.locator('input[placeholder="Display name (optional)"]').fill('David');
    await dialog.locator('button.submit').click();
    return await result;
  });

  await app.step('user.photoURL loads on the page', () => {
    assert.equal(report.topLoaded, true, `top page avatar image ${report.photoURL} failed to load`);
  });

  await app.step('the same photoURL loads inside a blob-URL iframe', () => {
    assert.deepEqual(report.iframe, { loaded: true, error: null }, `photoURL ${report.photoURL}`);
  });

  await app.step('user.photoURL is absolute on the page origin', () => {
    assert.ok(report.photoURL?.startsWith(avatarPrefix), `photoURL ${report.photoURL} is not under ${avatarPrefix}`);
  });

  await app.step('providerData[0].photoURL and auth-state snapshot equal user.photoURL', () => {
    assert.equal(report.providerPhotoURL, report.photoURL);
    assert.equal(report.authStatePhotoURL, report.photoURL);
    assert.equal(report.authStateProviderPhotoURL, report.photoURL);
  });

  await app.step('the sandbox sign_in event payload carries the same absolute photoURL', async () => {
    const eventsResult = await app.pyric(['sandbox', 'events', '--limit', '50', '--json']);
    assert.equal(eventsResult.code, 0, eventsResult.output);
    const jsonStart = eventsResult.output.indexOf('{');
    assert.ok(jsonStart >= 0, `expected JSON output from pyric sandbox events:\n${eventsResult.output}`);
    const parsed = JSON.parse(eventsResult.output.slice(jsonStart)) as SandboxEventsEnvelope;
    const signInEvent = parsed.data?.events?.find(
      (event) => event.service === 'auth' && event.method === 'sign_in' && event.path === report.uid,
    );
    assert.ok(signInEvent, `expected sign_in event for ${report.uid}`);
    assert.equal(signInEvent.auth?.token?.picture ?? null, report.photoURL);
  });

  await app.step('the ID token picture claim is the same absolute URL', () => {
    assert.equal(report.picture, report.photoURL);
  });

  await app.step('firebase-admin getUser returns the same absolute URL', async () => {
    const result = await app.serverScript('server.mjs', [report.uid], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
    const line = result.output.trim().split('\n').findLast((text) => text.startsWith('{'));
    assert.ok(line, 'server.mjs printed no JSON report');
    assert.equal((JSON.parse(line) as { photoURL: string | null }).photoURL, report.photoURL);
  });
});
