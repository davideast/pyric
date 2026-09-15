import { expect, test } from '@playwright/test';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { startSoakServe } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode}: tokens and Rules retain the signed-in tenant when the next tenant changes`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSoakServe({ flags, extraFiles: {
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents { match /tenants/{tenant} {
          allow read, write: if request.auth.token.firebase.tenant == tenant;
        } }
      }`,
      'index.html': '<output id="ready"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        const auth = getAuth(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        auth.tenantId = 'tenant-blue';
        const { user } = await signInAnonymously(auth);
        document.querySelector('#ready').textContent = user.uid;
      `,
    } });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText(/\S+/);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      const identity = await page.evaluate(async () => {
        const { getAuth, signOut, signInAnonymously } = await import('firebase/auth');
        const { getFirestore, doc, setDoc } = await import('firebase/firestore');
        const auth = getAuth();
        const user = auth.currentUser;
        const isSignedOut = user === null;
        if (isSignedOut) throw new Error('Expected the tenant-blue identity');
        const first = await user.getIdTokenResult();
        auth.tenantId = 'tenant-red';
        const refreshed = await user.getIdTokenResult(true);
        await setDoc(doc(getFirestore(), 'tenants/tenant-blue'), { owner: user.uid });
        let otherTenantWrite = 'allowed';
        try {
          await setDoc(doc(getFirestore(), 'tenants/tenant-red'), { owner: user.uid });
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) otherTenantWrite = String(error.code);
          else throw error;
        }
        const beforeSignOut = { configuredTenant: auth.tenantId, userTenant: user.tenantId,
          initialClaims: first.claims.firebase, refreshedClaims: refreshed.claims.firebase, otherTenantWrite };
        await signOut(auth);
        const { user: red } = await signInAnonymously(auth);
        const redToken = await red.getIdTokenResult(true);
        await setDoc(doc(getFirestore(), 'tenants/tenant-red'), { owner: red.uid });
        return { beforeSignOut, next: { tenant: red.tenantId, claims: redToken.claims.firebase } };
      });
      expect(identity).toMatchObject({
        beforeSignOut: { configuredTenant: 'tenant-red', userTenant: 'tenant-blue',
          initialClaims: { tenant: 'tenant-blue', sign_in_provider: 'anonymous' },
          refreshedClaims: { tenant: 'tenant-blue', sign_in_provider: 'anonymous' },
          otherTenantWrite: 'permission-denied' },
        next: { tenant: 'tenant-red', claims: { tenant: 'tenant-red', sign_in_provider: 'anonymous' } },
      });
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}

test('independent hosted sessions with one UID cache tokens under their own tenants', async () => {
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'] });
  const blue = await connectRemoteSandbox({ url: fixture.info.url });
  const red = await connectRemoteSandbox({ url: fixture.info.url });
  try {
    await blue.auth.createUser({ uid: 'shared-identity' });
    await blue.channel.op({ method: 'auth.restorePortSession', uid: 'shared-identity', tenantId: 'tenant-blue' });
    await red.channel.op({ method: 'auth.restorePortSession', uid: 'shared-identity', tenantId: 'tenant-red' });
    const blueToken = await blue.channel.op({ method: 'auth.getIdTokenResult', forceRefresh: true });
    const redToken = await red.channel.op({ method: 'auth.getIdTokenResult', forceRefresh: true });
    expect(blueToken).toMatchObject({ claims: { firebase: { tenant: 'tenant-blue' } } });
    expect(redToken).toMatchObject({ claims: { firebase: { tenant: 'tenant-red' } } });
    expect(await blue.channel.op({ method: 'auth.getIdTokenResult' })).toEqual(blueToken);
    expect(await red.channel.op({ method: 'auth.getIdTokenResult' })).toEqual(redToken);
  } finally {
    blue.close();
    red.close();
    await fixture.stop();
  }
});
