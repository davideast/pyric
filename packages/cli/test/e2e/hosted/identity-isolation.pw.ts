import { expect, test, type Page } from '@playwright/test';
import { once } from 'node:events';
import { startHost } from './host-process.js';
import { McpHttpClient, waitForPeer, startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

async function identityAndAccess(page: Page, appName: string) {
  return page.evaluate(async appName => {
    const { getApp } = await import('firebase/app');
    const { getAuth } = await import('firebase/auth');
    const sdk = await import('firebase/firestore');
    const app = getApp(appName);
    const user = getAuth(app).currentUser;
    const isSignedOut = user === null;
    if (isSignedOut) return { uid: null };
    const token = await user.getIdTokenResult(true);
    async function write(tenant: string, uid: string) {
      try {
        await sdk.setDoc(sdk.doc(sdk.getFirestore(app), 'tenants', tenant, 'profiles', uid), { message: 'Checked' });
        return 'written';
      } catch (error) {
        const isCodedError = error instanceof Error && 'code' in error;
        if (isCodedError) return String(error.code);
        throw error;
      }
    }
    return { uid: user.uid, tenant: user.tenantId, firebase: token.claims.firebase,
      role: token.claims.role, blue: await write('blue', 'blue-user'), red: await write('red', 'red-user') };
  }, appName);
}

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  const isHosted = mode === 'hosted';
  const topologies = isHosted
    ? ['named-app', 'second-page', 'named-app-after-restart', 'second-page-after-restart']
    : ['named-app', 'second-page'];
  for (const topology of topologies) {
    test(`${mode}: ${topology} identity changes preserve the other client's tenant and Rules access`, async ({ context, page }) => {
      const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
      const secondPage = topology.startsWith('second-page');
      const restartsHost = topology.endsWith('after-restart');
      let replacement: ReturnType<typeof startHost> | undefined;
      const other = secondPage ? await context.newPage() : page;
      await prepareRuntimeFixture(other, mode);
      const fixture = await startSoakServe({ flags: [...flags, '--seed', 'fixture.json'], extraFiles: {
        'fixture.json': JSON.stringify({ version: 1, firestore: null, auth: { users: [
          { uid: 'blue-user', email: 'blue@example.test', password: 'password', providerId: 'password', tenantId: 'blue', customClaims: { role: 'editor' } },
          { uid: 'red-user', email: 'red@example.test', password: 'password', providerId: 'password', tenantId: 'red', customClaims: { role: 'viewer' } },
        ] } }),
        'firestore.rules': `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents {
          match /tenants/{tenant}/profiles/{uid} { allow read, write: if request.auth.uid == uid
            && request.auth.token.firebase.tenant == tenant && request.auth.token.role == 'editor'; }
        } }`,
        'index.html': '<output id="ready"></output><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
          const tenant = new URL(location.href).searchParams.get('tenant') ?? 'blue';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          const auth = getAuth(app);
          auth.tenantId = tenant;
          await signInWithEmailAndPassword(auth, tenant + '@example.test', 'password');
          document.querySelector('#ready').textContent = tenant;
        `,
      } });
      const otherApp = secondPage ? '[DEFAULT]' : 'other';
      try {
        await page.goto(fixture.info.url);
        await expect(page.locator('#ready')).toHaveText('blue');
        await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
        if (secondPage) {
          await other.goto(fixture.info.url + '?tenant=red');
          await expect(other.locator('#ready')).toHaveText('red');
          await expect.poll(() => other.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
        } else {
          await page.evaluate(async () => {
            const { initializeApp } = await import('firebase/app');
            const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');
            const auth = getAuth(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }, 'other'));
            auth.tenantId = 'red';
            await signInWithEmailAndPassword(auth, 'red@example.test', 'password');
          });
        }
        const blue = { uid: 'blue-user', tenant: 'blue', firebase: { tenant: 'blue', sign_in_provider: 'password' },
          role: 'editor', blue: 'written', red: 'permission-denied' };
        const red = { uid: 'red-user', tenant: 'red', firebase: { tenant: 'red', sign_in_provider: 'password' },
          role: 'viewer', blue: 'permission-denied', red: 'permission-denied' };
        expect(await identityAndAccess(page, '[DEFAULT]')).toMatchObject(blue);
        expect(await identityAndAccess(other, otherApp)).toMatchObject(red);
        await waitForPeer(fixture.info.url);
        const control = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
        await control.initialize();
        await expect(control.toolCall('auth_set_claims', { uid: 'red-user', claims: { role: 'editor' } })).resolves.toMatchObject({ ok: true });
        const redEditor = { ...red, role: 'editor', red: 'written' };
        await expect.poll(() => identityAndAccess(other, otherApp)).toMatchObject(redEditor);
        expect(await identityAndAccess(page, '[DEFAULT]')).toMatchObject(blue);
        if (restartsHost) {
          await other.evaluate(async appName => {
            const { getApp } = await import('firebase/app');
            const { getAuth } = await import('firebase/auth');
            getAuth(getApp(appName)).tenantId = 'blue';
          }, otherApp);
          const exited = once(fixture.child, 'exit');
          fixture.child.kill('SIGTERM');
          await exited;
          replacement = startHost(fixture.dir, fixture.info.port);
          expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
          await expect.poll(() => identityAndAccess(page, '[DEFAULT]').catch(() => null), { timeout: 10_000 }).toMatchObject(blue);
          await expect.poll(() => identityAndAccess(other, otherApp).catch(() => null), { timeout: 10_000 }).toMatchObject(redEditor);
        }
        await other.evaluate(async appName => {
          const { getApp } = await import('firebase/app');
          const { getAuth } = await import('firebase/auth');
          getAuth(getApp(appName)).tenantId = 'blue';
        }, otherApp);
        expect(await identityAndAccess(other, otherApp)).toMatchObject(redEditor);
        expect(await identityAndAccess(page, '[DEFAULT]')).toMatchObject(blue);
        await other.evaluate(async appName => {
          const { getApp } = await import('firebase/app');
          const { getAuth, signOut } = await import('firebase/auth');
          await signOut(getAuth(getApp(appName)));
        }, otherApp);
        expect(await identityAndAccess(other, otherApp)).toEqual({ uid: null });
        expect(await identityAndAccess(page, '[DEFAULT]')).toMatchObject(blue);
        await other.evaluate(async appName => {
          const { getApp } = await import('firebase/app');
          const { getAuth, signInWithEmailAndPassword } = await import('firebase/auth');
          await signInWithEmailAndPassword(getAuth(getApp(appName)), 'blue@example.test', 'password');
        }, otherApp);
        expect(await identityAndAccess(other, otherApp)).toMatchObject(blue);
        expect(await identityAndAccess(page, '[DEFAULT]')).toMatchObject(blue);
      } finally {
        await other.close();
        await page.close();
        await replacement?.stop();
        await fixture.stop();
      }
    });
  }
}
