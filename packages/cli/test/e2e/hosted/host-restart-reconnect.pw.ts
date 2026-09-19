import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('hosted SDK writes resume in the existing app after a host process restart', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const existingPage = await browser.newPage();
  try {
    await existingPage.goto(fixture.info.url);
    await expect(existingPage.locator('#document')).toHaveText('Empty');
    await existingPage.evaluate(async () => {
      const sdk = await import('firebase/firestore');
      await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Before restart' });
    });
    await expect(existingPage.locator('#document')).toHaveText('Before restart');

    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const freshPage = await browser.newPage();
      try {
        await freshPage.goto(fixture.info.url);
        await expect(freshPage.locator('#document')).toHaveText('Before restart');
        await expect.poll(async () => {
          await existingPage.getByRole('button', { name: 'Write shared document', exact: true }).click();
          return existingPage.locator('#write-result').innerText();
        }, { timeout: 10_000 }).toBe('Written');
        await expect(existingPage.locator('#document')).toHaveText('Hello from the other browser');
        await expect(freshPage.locator('#document')).toHaveText('Hello from the other browser');
      } finally {
        await freshPage.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await existingPage.close();
    await fixture.stop();
  }
});

test('invalid resume grants cannot use missing or malformed host identity to obtain admission', async ({ page, request }) => {
  const fixture = await startHostedFixture();
  try {
    const response = await request.get(`${fixture.info.url}/__pyric/health`);
    const health: unknown = await response.json();
    const isHealthRecord = typeof health === 'object' && health !== null && 'instanceId' in health;
    if (isHealthRecord) {
      const hostInstanceId = health.instanceId;
      expect(typeof hostInstanceId).toBe('string');
      for (const claimedInstance of [undefined, hostInstanceId, null, 123, '']) {
        const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
        let outcome: number | string = 'pending';
        socket.addEventListener('close', event => { outcome = event.code; });
        socket.addEventListener('message', event => {
          const frame: unknown = JSON.parse(event.data);
          const isFrame = isBridgeMessage(frame);
          const admitsSession = isFrame && frame.type === 'attach-ack';
          if (admitsSession) outcome = 'admitted';
        });
        try {
          await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
          socket.send(JSON.stringify({
            type: 'attach', protocol: 1, transport: 'worker-port',
            resumeToken: 'not-a-grant', hostInstanceId: claimedInstance,
          }));
          await expect.poll(() => outcome).not.toBe('pending');
          expect(outcome).toBe(1008);
        } finally {
          socket.close();
        }
      }
    } else {
      throw new Error('The host did not publish its instance identity');
    }
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.getByRole('button', { name: 'Write shared document', exact: true }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
  } finally {
    await page.close();
    await fixture.stop();
  }
});

test('restart recovery does not recreate a user deleted before the app is readmitted', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  const admissionAllowed = Promise.withResolvers<void>();
  let isRestarting = false;
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      route.onMessage(async data => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        const holdsAdmission = isRestarting && isBridgeFrame && frame.type === 'attach';
        if (holdsAdmission) await admissionAllowed.promise;
        server.send(data);
      });
    });
    const page = await context.newPage();
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const uid = await page.evaluate(async () => {
      const { getAuth, onAuthStateChanged } = await import('firebase/auth');
      const auth = getAuth();
      const user = auth.currentUser;
      const isSignedOut = user === null;
      if (isSignedOut) throw new Error('Expected the original user');
      onAuthStateChanged(auth, current => { document.body.dataset.authUid = current?.uid ?? 'signed-out'; });
      return user.uid;
    });
    await expect(page.locator('body')).toHaveAttribute('data-auth-uid', uid);
    isRestarting = true;
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await control.auth.deleteUser(uid);
        admissionAllowed.resolve();
        await expect(page.locator('body')).toHaveAttribute('data-auth-uid', 'signed-out', { timeout: 10_000 });
        const writeResult = await page.evaluate(async () => {
          const sdk = await import('firebase/firestore');
          try {
            await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Forbidden' });
            return 'written';
          } catch (error) {
            const isCodedError = error instanceof Error && 'code' in error;
            if (isCodedError) return error.code;
            throw error;
          }
        });
        expect(writeResult).toBe('permission-denied');
        expect(await control.auth.listUsers()).toEqual([]);
      } finally {
        control.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    admissionAllowed.resolve();
    await context.close();
    await fixture.stop();
  }
});

test('a restarted host restores tenant identity and claims before existing listeners and writes', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /profiles/{uid} {
            allow read, write: if request.auth.uid == uid
              && request.auth.token.firebase.tenant == 'tenant-blue'
              && request.auth.token.role == 'editor';
          }
        }
      }`,
      'index.html': '<output id="identity">Starting</output><output id="document">Empty</output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
        const auth = getAuth(initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' }));
        auth.tenantId = 'tenant-blue';
        await signInAnonymously(auth);
        onAuthStateChanged(auth, user => {
          const isSignedIn = user !== null;
          let identity = 'Signed out';
          if (isSignedIn) identity = user.uid + '/' + user.tenantId;
          document.querySelector('#identity').textContent = identity;
        });
      `,
    },
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#identity')).toHaveText(/.+\/tenant-blue/);
    const identity = await page.locator('#identity').innerText();
    const uid = identity.split('/')[0];
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.auth.updateUser(uid, { customClaims: { role: 'editor' } });
    } finally {
      control.close();
    }
    await page.evaluate(async (uid) => {
      const { getAuth } = await import('firebase/auth');
      const sdk = await import('firebase/firestore');
      const user = getAuth().currentUser;
      const isSignedOut = user === null;
      if (isSignedOut) throw new Error('Expected the original signed-in user');
      await user.getIdTokenResult(true);
      const reference = sdk.doc(sdk.getFirestore(), 'profiles', uid);
      await sdk.setDoc(reference, { message: 'Before restart' });
      sdk.onSnapshot(reference, snapshot => {
        const output = document.querySelector('#document');
        const hasOutput = output !== null;
        if (hasOutput) output.textContent = snapshot.data()?.message ?? 'Missing';
      });
    }, uid);
    await expect(page.locator('#document')).toHaveText('Before restart');

    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const restoredControl = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await restoredControl.channel.op({ method: 'setDoc', path: `profiles/${uid}`, data: { message: 'After restart' }, actAs: { mode: 'admin' } });
      } finally {
        restoredControl.close();
      }
      await expect(page.locator('#document')).toHaveText('After restart', { timeout: 10_000 });
      await expect(page.locator('#identity')).toHaveText(identity);
      const restored = await page.evaluate(async (uid) => {
        const { getAuth } = await import('firebase/auth');
        const sdk = await import('firebase/firestore');
        const user = getAuth().currentUser;
        const isSignedOut = user === null;
        if (isSignedOut) throw new Error('The original session was not restored');
        const token = await user.getIdTokenResult();
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'profiles', uid), { message: 'Written after restart' });
        let deniedCode;
        try {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'profiles/another-owner'), { message: 'Forbidden' });
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) deniedCode = error.code;
        }
        return { uid: user.uid, tenant: user.tenantId, role: token.claims.role, deniedCode };
      }, uid);
      expect(restored).toEqual({ uid, tenant: 'tenant-blue', role: 'editor', deniedCode: 'permission-denied' });
      await expect(page.locator('#document')).toHaveText('Written after restart');
      await page.evaluate(async () => {
        const { getAuth, signOut } = await import('firebase/auth');
        await signOut(getAuth());
      });
      await expect(page.locator('#identity')).toHaveText('Signed out');
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
