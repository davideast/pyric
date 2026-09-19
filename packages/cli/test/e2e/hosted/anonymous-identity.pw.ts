import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

function startIdentityFixture(flags = ['--hosted', '--no-capture']) {
  return startSoakServe({
    flags,
    extraFiles: {
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /profiles/{uid} { allow read, write: if request.auth.uid == uid; }
        }
      }`,
      'index.html': '<output id="uid"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const { user } = await signInAnonymously(getAuth(app));
        document.querySelector('#uid').textContent = user.uid;
      `,
    },
  });
}

test('a new anonymous identity cannot inherit a deleted user UID or protected data after restart', async ({ page }) => {
  const fixture = await startIdentityFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#uid')).toHaveText(/\S+/);
    const uid = await page.locator('#uid').innerText();
    await page.evaluate(async uid => {
      const sdk = await import('firebase/firestore');
      await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'profiles', uid), { secret: 'Original owner' });
    }, uid);
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await control.auth.deleteUser(uid);
        expect(await control.auth.listUsers()).toEqual([]);
      } finally {
        control.close();
      }
      await page.goto(fixture.info.url);
      await expect(page.locator('#uid')).toHaveText(/\S+/);
      const newUid = await page.locator('#uid').innerText();
      expect.soft(newUid).not.toBe(uid);
      const readResult = await page.evaluate(async uid => {
        const sdk = await import('firebase/firestore');
        try {
          const snapshot = await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'profiles', uid));
          return snapshot.data()?.secret;
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) return error.code;
          throw error;
        }
      }, uid);
      expect(readResult).toBe('permission-denied');
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

for (const deletesBeforeRestart of [true, false]) {
  const originalAccount = deletesBeforeRestart ? 'deleted' : 'retained';
  test(`fresh anonymous sign-in after restart preserves the ${originalAccount} original account state`, async ({ page }) => {
    const fixture = await startIdentityFixture();
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#uid')).toHaveText(/\S+/);
      const uid = await page.locator('#uid').innerText();
      await page.evaluate(async () => {
        const { getAuth, signOut } = await import('firebase/auth');
        await signOut(getAuth());
      });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      let originalUsers;
      try {
        await control.auth.updateUser(uid, { customClaims: { role: 'original-owner' } });
        if (deletesBeforeRestart) await control.auth.deleteUser(uid);
        originalUsers = await control.auth.listUsers();
      } finally {
        control.close();
      }
      await page.goto('about:blank');
      const exited = once(fixture.child, 'exit');
      fixture.child.kill('SIGKILL');
      await exited;
      const replacement = startHost(fixture.dir, fixture.info.port);
      try {
        expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
        await page.goto(fixture.info.url);
        await expect(page.locator('#uid')).toHaveText(/\S+/);
        const newUid = await page.locator('#uid').innerText();
        expect(newUid).not.toBe(uid);
        const restored = await connectRemoteSandbox({ url: fixture.info.url });
        try {
          const users = await restored.auth.listUsers();
          expect(users.filter(user => user.uid === uid)).toMatchObject(originalUsers);
          expect(users.map(user => user.uid)).toContain(newUid);
          expect(users).toHaveLength(originalUsers.length + 1);
        } finally {
          restored.close();
        }
      } finally {
        await replacement.stop();
      }
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}

for (const hosting of ['hosted', 'SharedWorker', 'in-page']) {
  test(`${hosting} anonymous deletion creates a distinct Rules identity on the next sign-in`, async ({ page }) => {
    const usesHostedSandbox = hosting === 'hosted';
    const flags = usesHostedSandbox ? ['--hosted', '--no-capture'] : ['--no-capture'];
    const fixture = await startIdentityFixture(flags);
    try {
      const usesInPageSandbox = hosting === 'in-page';
      if (usesInPageSandbox) {
        await page.addInitScript(() => { Object.assign(globalThis, { __PYRIC_FORCE_INPAGE__: true }); });
      }
      await page.goto(fixture.info.url);
      await expect(page.locator('#uid')).toHaveText(/\S+/);
      const result = await page.evaluate(async () => {
        const { deleteUser, getAuth, signInAnonymously } = await import('firebase/auth');
        const sdk = await import('firebase/firestore');
        const auth = getAuth();
        const original = auth.currentUser;
        const isSignedOut = original === null;
        if (isSignedOut) throw new Error('Expected an anonymous identity');
        const originalProfile = sdk.doc(sdk.getFirestore(), 'profiles', original.uid);
        await sdk.setDoc(originalProfile, { secret: 'Original owner' });
        await deleteUser(original);
        const signedOutAfterDeletion = auth.currentUser === null;
        const { user } = await signInAnonymously(auth);
        const ownProfile = sdk.doc(sdk.getFirestore(), 'profiles', user.uid);
        await sdk.setDoc(ownProfile, { secret: 'New owner' });
        const ownData = (await sdk.getDoc(ownProfile)).data();
        let oldProfileError;
        try {
          await sdk.getDoc(originalProfile);
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) oldProfileError = error.code;
        }
        return { originalUid: original.uid, uid: user.uid, isAnonymous: user.isAnonymous,
          signedOutAfterDeletion, ownData, oldProfileError };
      });
      expect(result.uid).not.toBe(result.originalUid);
      expect(result).toMatchObject({ isAnonymous: true, signedOutAfterDeletion: true,
        ownData: { secret: 'New owner' }, oldProfileError: 'permission-denied' });
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
