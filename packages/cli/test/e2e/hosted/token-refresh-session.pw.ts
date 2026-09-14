import { expect, test } from '@playwright/test';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';
import { prepareRuntimeFixture } from './runtime-fixture.js';

for (const method of ['getIdToken', 'getIdTokenResult'] as const) {
  test(`in-page ${method} refreshes Rules claims without restoring a previous identity`, async ({ page }) => {
    test.setTimeout(30_000);
    const { flags, expectedMode } = await prepareRuntimeFixture(page, 'inpage');
    const fixture = await startSoakServe({ flags, extraFiles: {
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{db}/documents {
          match /identity/{uid} { allow read, write: if request.auth.uid == uid; }
          match /privileged/{uid} { allow read, write: if request.auth.uid == uid && request.auth.token.role == 'editor'; }
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
    } });
    try {
      await page.goto(fixture.info.url);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(expectedMode);
      await expect(page.locator('#uid')).toHaveText(/\S+/);
      const uid = await page.locator('#uid').innerText();
      await waitForPeer(fixture.info.url);
      const control = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
      await control.initialize();
      await expect(control.toolCall('auth_set_claims', { uid, claims: { role: 'editor' } })).resolves.toMatchObject({ ok: true });
      const result = await page.evaluate(async method => {
        const { getAuth, signInAnonymously, signOut } = await import('firebase/auth');
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        const auth = getAuth();
        const previous = auth.currentUser;
        const isSignedOut = previous === null;
        if (isSignedOut) throw new Error('Expected the original identity');
        await previous[method](true);
        await setDoc(doc(getFirestore(), 'privileged', previous.uid), { message: 'Authorized by refreshed claims' });
        await signOut(auth);
        const { user: current } = await signInAnonymously(auth);
        await previous[method](true);
        await setDoc(doc(getFirestore(), 'identity', current.uid), { message: 'Still the current identity' });
        let privilegedWrite = 'allowed';
        try {
          await setDoc(doc(getFirestore(), 'privileged', current.uid), { message: 'Must refuse' });
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) privilegedWrite = String(error.code);
          else throw error;
        }
        const currentUid = auth.currentUser?.uid;
        await signOut(auth);
        await previous[method](true);
        let signedOutWrite = 'allowed';
        try {
          await setDoc(doc(getFirestore(), 'identity', previous.uid), { message: 'Must refuse' });
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) signedOutWrite = String(error.code);
          else throw error;
        }
        return { previousUid: previous.uid, nextUid: current.uid, currentUid,
          privilegedWrite, signedOutWrite, remainsSignedOut: auth.currentUser === null };
      }, method);
      expect(result.previousUid).toBe(uid);
      expect(result.nextUid).not.toBe(uid);
      expect(result.currentUid).toBe(result.nextUid);
      expect(result).toMatchObject({ privilegedWrite: 'permission-denied', signedOutWrite: 'permission-denied', remainsSignedOut: true });
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
