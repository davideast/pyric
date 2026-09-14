import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test, type Page } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startSoakServe } from '../soak/harness.js';

async function readCheckpointClaim(page: Page, reloadProfile = false) {
  return page.evaluate(async reloadProfile => {
    const { getAuth, reload } = await import('firebase/auth');
    const user = getAuth().currentUser;
    const isSignedOut = user === null;
    if (isSignedOut) throw new Error('Expected the checkpoint owner');
    if (reloadProfile) await reload(user);
    return (await user.getIdTokenResult(true)).claims.checkpointVersion;
  }, reloadProfile);
}

test('checkpoint restore refreshes claims on the existing signed-in user', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const uid = await page.evaluate(async () => {
      const { getAuth, createUserWithEmailAndPassword } = await import('firebase/auth');
      return (await createUserWithEmailAndPassword(getAuth(), 'checkpoint@example.test', 'fixture-password')).user.uid;
    });
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.auth.updateUser(uid, { customClaims: { checkpointVersion: 'saved' } });
      expect(await readCheckpointClaim(page)).toBe('saved');
      await control.channel.op({ method: 'checkpoint', name: 'identity' });
      await control.auth.updateUser(uid, { customClaims: { checkpointVersion: 'changed' } });
      expect(await readCheckpointClaim(page)).toBe('changed');
      await control.channel.op({ method: 'restore', name: 'identity' });
      expect(await readCheckpointClaim(page, true)).toBe('saved');
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  for (const operation of ['reload', 'updateEmail', 'updatePassword'] as const) {
    test(`${mode} ${operation} cannot restore revoked claims from an older session`, async ({ page }) => {
      const isHosted = mode === 'hosted';
      const isInpage = mode === 'inpage';
      const flags = ['--no-capture'];
      if (isHosted) flags.push('--hosted');
      if (isInpage) flags.push('--inpage');
      const fixture = await startSoakServe({ flags, extraFiles: {
        'firestore.rules': `rules_version = '2'; service cloud.firestore {
          match /databases/{database}/documents { match /profiles/{uid} {
            allow read, write: if request.auth.uid == uid
              && request.auth.token.firebase.tenant == 'tenant-blue'
              && request.auth.token.role == 'editor';
          } }
        }`,
        'index.html': '<output id="ready"></output><script type="module" src="/main.js"></script>',
        'main.js': `
          import { initializeApp } from 'firebase/app';
          import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';
          const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
          const auth = getAuth(app);
          auth.tenantId = 'tenant-blue';
          const { user } = await createUserWithEmailAndPassword(auth, 'claims@example.test', 'fixture-password');
          document.querySelector('#ready').textContent = user.uid;
        `,
      } });
      try {
        await page.goto(fixture.info.url);
        await expect(page.locator('#ready')).toHaveText(/\S+/);
        const uid = await page.locator('#ready').innerText();
        const control = await connectRemoteSandbox({ url: fixture.info.url });
        try {
          await control.auth.updateUser(uid, { customClaims: { role: 'editor' } });
          await page.evaluate(async () => {
            const { getAuth } = await import('firebase/auth');
            const { doc, getFirestore, setDoc } = await import('firebase/firestore');
            const user = getAuth().currentUser;
            const isSignedOut = user === null;
            if (isSignedOut) throw new Error('Expected the authenticated owner');
            await user.getIdTokenResult(true);
            await setDoc(doc(getFirestore(), 'profiles', user.uid), { message: 'Allowed' });
          });
          await control.auth.updateUser(uid, { customClaims: { role: 'viewer' } });
          const refreshed = await page.evaluate(async operation => {
            const auth = await import('firebase/auth');
            const { doc, getFirestore, setDoc } = await import('firebase/firestore');
            const user = auth.getAuth().currentUser;
            const isSignedOut = user === null;
            if (isSignedOut) throw new Error('Expected the authenticated owner');
            switch (operation) {
              case 'reload': await auth.reload(user); break;
              case 'updateEmail': await auth.updateEmail(user, 'updated@example.test'); break;
              case 'updatePassword': await auth.updatePassword(user, 'updated-password'); break;
            }
            const token = await user.getIdTokenResult(true);
            let writeResult = 'allowed';
            try {
              await setDoc(doc(getFirestore(), 'profiles', user.uid), { message: 'Must refuse' });
            } catch (error) {
              const isCodedError = error instanceof Error && 'code' in error;
              if (isCodedError) writeResult = String(error.code);
              else throw error;
            }
            return { role: token.claims.role, tenant: user.tenantId, writeResult };
          }, operation);
          expect(refreshed).toEqual({ role: 'viewer', tenant: 'tenant-blue', writeResult: 'permission-denied' });
          expect(await control.auth.listUsers()).toMatchObject([{ uid, customClaims: { role: 'viewer' } }]);
        } finally {
          control.close();
        }
      } finally {
        await page.close();
        await fixture.stop();
      }
    });
  }
}
