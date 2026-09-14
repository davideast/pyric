import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

function startExpiryFixture() {
  return startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents {
          match /profiles/{uid} { allow read, write: if request.auth.uid == uid; }
        }
      }`,
      'index.html': '<output id="uid"></output><output id="document"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const { user } = await signInAnonymously(getAuth(app));
        const profile = doc(getFirestore(app), 'profiles', user.uid);
        await setDoc(profile, { message: 'Before expiry' });
        document.querySelector('#uid').textContent = user.uid;
        onSnapshot(profile, snapshot => {
          document.querySelector('#document').textContent = snapshot.data()?.message ?? 'Missing';
        }, error => { document.querySelector('#document').textContent = error.code; });
      `,
    },
  });
}

test('an existing app obtains fresh admission after the hosted session retention window', async ({ browser }) => {
  test.setTimeout(100_000);
  const fixture = await startExpiryFixture();
  const context = await browser.newContext();
  let holdsAdmission = false;
  let cutConnection: (() => Promise<void>) | undefined;
  let originalGrant: string | undefined;
  let originalHost: string | undefined;
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      let sessionGrant: string | undefined;
      let issuingHost: string | undefined;
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        const acknowledgesAttach = isBridgeFrame && frame.type === 'attach-ack';
        if (acknowledgesAttach) {
          sessionGrant = frame.resumeToken;
          issuingHost = frame.hostInstanceId;
        }
        route.send(data);
      });
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isBridgeFrame = isBridgeMessage(frame);
        if (isBridgeFrame) {
          const dropsAttach = holdsAdmission && frame.type === 'attach';
          if (dropsAttach) return;
          const startsListener = frame.type === 'worker-message' && frame.message.t === 'sub';
          if (startsListener) {
            cutConnection = async () => {
              originalGrant = sessionGrant;
              originalHost = issuingHost;
              holdsAdmission = true;
              await route.close({ code: 1001, reason: 'Fixture connection interruption' });
              await server.close();
            };
          }
        }
        server.send(data);
      });
    });
    const page = await context.newPage();
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Before expiry');
    const uid = await page.locator('#uid').innerText();
    const cut = cutConnection;
    const hasNoListener = cut === undefined;
    if (hasNoListener) throw new Error('The app never subscribed');
    await cut();
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'setDoc', path: `profiles/${uid}`,
        data: { message: 'After expiry' }, actAs: { mode: 'admin' } });
      // Exercise the published 60-second retention policy with the real host clock.
      await new Promise(resolve => setTimeout(resolve, 62_000));
      const hasNoGrant = originalGrant === undefined;
      if (hasNoGrant) throw new Error('Expected the original admitted session grant');
      const expired = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      let outcome: number | string = 'pending';
      expired.addEventListener('close', event => { outcome = event.code; });
      expired.addEventListener('message', event => {
        const frame: unknown = JSON.parse(event.data);
        const isBridgeFrame = isBridgeMessage(frame);
        const admitsSession = isBridgeFrame && frame.type === 'attach-ack';
        if (admitsSession) outcome = 'admitted';
      });
      try {
        await expect.poll(() => expired.readyState).toBe(WebSocket.OPEN);
        expired.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port',
          resumeToken: originalGrant, hostInstanceId: originalHost }));
        await expect.poll(() => outcome).not.toBe('pending');
        expect(outcome).toBe(1008);
      } finally {
        expired.close();
      }
      holdsAdmission = false;
      await expect(page.locator('#document')).toHaveText('After expiry', { timeout: 15_000 });
      const restoredUid = await page.evaluate(async () => {
        const { getAuth } = await import('firebase/auth');
        const sdk = await import('firebase/firestore');
        const user = getAuth().currentUser;
        const isSignedOut = user === null;
        if (isSignedOut) throw new Error('Expected the original identity');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'profiles', user.uid), { message: 'Recovered' });
        return user.uid;
      });
      expect(restoredUid).toBe(uid);
      await expect(page.locator('#document')).toHaveText('Recovered');
      expect(await control.auth.listUsers()).toHaveLength(1);
    } finally {
      control.close();
    }
  } finally {
    await context.close();
    await fixture.stop();
  }
});

for (const scenario of ['deleted-user', 'deleted-app', 'invalid-grant', 'fresh-retry'] as const) {
  test(`expiry recovery respects ${scenario}`, async ({ browser }) => {
    const fixture = await startExpiryFixture();
    const context = await browser.newContext();
    const rejected = Promise.withResolvers<void>();
    let holdsAdmission = false;
    let corruptsResume = false;
    let dropsFreshAttempt = false;
    let freshAttempts = 0;
    let cutConnection: (() => Promise<void>) | undefined;
    try {
      await context.routeWebSocket('**/*', route => {
        const server = route.connectToServer();
        server.onClose((code, reason) => {
          const rejectsAdmission = code === 1008;
          if (rejectsAdmission) rejected.resolve();
          route.close({ code, reason });
        });
        route.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const isBridgeFrame = isBridgeMessage(frame);
          if (isBridgeFrame) {
            const isAttach = frame.type === 'attach' && frame.transport === 'worker-port';
            if (isAttach) {
              if (holdsAdmission) return;
              const resumesSession = frame.resumeToken !== undefined;
              const sendsInvalidGrant = corruptsResume && resumesSession;
              if (sendsInvalidGrant) {
                server.send(JSON.stringify({ ...frame, resumeToken: 'invalid-fixture-grant' }));
                return;
              }
              const startsFreshSession = !resumesSession;
              if (startsFreshSession) {
                freshAttempts += 1;
                if (dropsFreshAttempt) {
                  dropsFreshAttempt = false;
                  route.close({ code: 1001, reason: 'Fixture drops first fresh admission' });
                  server.close();
                  return;
                }
              }
            }
            const startsListener = frame.type === 'worker-message' && frame.message.t === 'sub';
            if (startsListener) {
              cutConnection = async () => {
                holdsAdmission = true;
                await route.close({ code: 1001, reason: 'Fixture connection interruption' });
                await server.close();
              };
            }
          }
          server.send(data);
        });
      });
      const page = await context.newPage();
      await page.clock.install();
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Before expiry');
      const uid = await page.locator('#uid').innerText();
      const cut = cutConnection;
      const hasNoListener = cut === undefined;
      if (hasNoListener) throw new Error('The app never subscribed');
      await cut();
      await expect.poll(() => page.evaluate(async uid => {
        const sdk = await import('firebase/firestore');
        try {
          await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'profiles', uid));
          return 'connected';
        } catch (error) {
          const isCodedError = error instanceof Error && 'code' in error;
          if (isCodedError) return error.code;
          throw error;
        }
      }, uid)).toBe('unavailable');
      const initialFreshAttempts = freshAttempts;
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const deletesUser = scenario === 'deleted-user';
        if (deletesUser) await control.auth.deleteUser(uid);
        const deletesApp = scenario === 'deleted-app';
        if (deletesApp) {
          await page.evaluate(async () => {
            const { deleteApp, getApp } = await import('firebase/app');
            await deleteApp(getApp());
          });
        }
        corruptsResume = scenario === 'invalid-grant';
        dropsFreshAttempt = scenario === 'fresh-retry';
        holdsAdmission = false;
        if (corruptsResume) {
          await page.clock.runFor(1_000);
          await rejected.promise;
        }
        await page.clock.fastForward(62_000);

        if (deletesUser) {
          await expect(page.locator('#document')).toHaveText('permission-denied');
          expect(await page.evaluate(async () => {
            const { getAuth } = await import('firebase/auth');
            return getAuth().currentUser?.uid ?? null;
          })).toBeNull();
          expect(await control.auth.listUsers()).toEqual([]);
        } else {
          const retriesFreshAdmission = scenario === 'fresh-retry';
          if (retriesFreshAdmission) {
            await control.channel.op({ method: 'setDoc', path: `profiles/${uid}`,
              data: { message: 'After expiry' }, actAs: { mode: 'admin' } });
            await expect(page.locator('#document')).toHaveText('After expiry', { timeout: 15_000 });
            expect(freshAttempts - initialFreshAttempts).toBe(2);
            expect(await control.auth.listUsers()).toHaveLength(1);
          } else {
            expect(freshAttempts).toBe(initialFreshAttempts);
            expect(await control.auth.listUsers()).toHaveLength(1);
          }
        }
      } finally {
        control.close();
      }
    } finally {
      await context.close();
      await fixture.stop();
    }
  });
}
