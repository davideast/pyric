import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

for (const change of ['claims-revoked', 'account-disabled'] as const) {
  test(`restart recovery applies ${change} before restoring Rules access`, async ({ context, page }) => {
    const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture', '--seed', 'fixture.json'], extraFiles: {
      'fixture.json': JSON.stringify({ version: 1, firestore: null, auth: { users: [
        { uid: 'owner', email: 'owner@example.test', password: 'password', providerId: 'password', tenantId: 'blue', customClaims: { role: 'editor' } },
      ] } }),
      'firestore.rules': `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents {
        match /profiles/{uid} {
          allow read: if request.auth.uid == uid && request.auth.token.firebase.tenant == 'blue';
          allow write: if request.auth.uid == uid && request.auth.token.firebase.tenant == 'blue' && request.auth.token.role == 'editor';
        }
      } }`,
      'index.html': '<output id="document"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
        import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
        const auth = getAuth(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        auth.tenantId = 'blue';
        await signInWithEmailAndPassword(auth, 'owner@example.test', 'password');
        const reference = doc(getFirestore(), 'profiles/owner');
        await setDoc(reference, { message: 'Before' });
        onSnapshot(reference, snapshot => { document.querySelector('#document').textContent = snapshot.data()?.message; },
          error => { document.querySelector('#document').textContent = error.code; });
      `,
    } });
    const admit = Promise.withResolvers<void>();
    let holdsAdmission = false;
    let replacement: ReturnType<typeof startHost> | undefined;
    try {
      await context.routeWebSocket('**/*', route => {
        const server = route.connectToServer();
        route.onMessage(async data => {
          const frame: unknown = JSON.parse(data.toString());
          const isFrame = isBridgeMessage(frame);
          const waitsForIdentityChange = holdsAdmission && isFrame && frame.type === 'attach';
          if (waitsForIdentityChange) await admit.promise;
          server.send(data);
        });
      });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Before');
      holdsAdmission = true;
      const exited = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await exited;
      replacement = startHost(fixture.dir, fixture.info.port);
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const disablesAccount = change === 'account-disabled';
        const update = disablesAccount ? { disabled: true } : { customClaims: { role: 'viewer' } };
        await control.auth.updateUser('owner', update);
        await control.channel.op({ method: 'setDoc', path: 'profiles/owner', data: { message: 'After' }, actAs: { mode: 'admin' } });
        holdsAdmission = false;
        admit.resolve();
        const expectedDocument = disablesAccount ? 'permission-denied' : 'After';
        await expect(page.locator('#document')).toHaveText(expectedDocument, { timeout: 10_000 });
        const identity = await page.evaluate(async () => {
          const { getAuth } = await import('firebase/auth');
          const sdk = await import('firebase/firestore');
          const user = getAuth().currentUser;
          const token = await user?.getIdTokenResult();
          let writeResult = 'written';
          try { await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'profiles/owner'), { message: 'Forbidden' }); }
          catch (error) {
            const isCodedError = error instanceof Error && 'code' in error;
            if (isCodedError) writeResult = String(error.code);
            else throw error;
          }
          return { uid: user?.uid ?? null, role: token?.claims.role ?? null, tenant: user?.tenantId ?? null, writeResult };
        });
        const expectedIdentity = disablesAccount
          ? { uid: null, role: null, tenant: null, writeResult: 'permission-denied' }
          : { uid: 'owner', role: 'viewer', tenant: 'blue', writeResult: 'permission-denied' };
        expect(identity).toEqual(expectedIdentity);
      } finally { control.close(); }
    } finally {
      admit.resolve();
      await page.close();
      await replacement?.stop();
      await fixture.stop();
    }
  });
}
