import { connectRemoteSandbox } from '@pyric/cli/remote';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';

test('a second socket loss during Auth restoration recovers one active document listener', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startSoakServe({
    flags: ['--hosted', '--no-capture'],
    extraFiles: {
      'firestore.rules': 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /profiles/{uid} { allow read, write: if request.auth.uid == uid; } } }',
      'index.html': '<output id="uid"></output><output id="current"></output><ol id="events"></ol><output id="error"></output><script type="module" src="/main.js"></script>',
      'main.js': `
        import { initializeApp } from 'firebase/app';
        import { getAuth, signInAnonymously } from 'firebase/auth';
        import { doc, getFirestore, onSnapshot, setDoc } from 'firebase/firestore';
        const app = initializeApp({ apiKey: 'demo', projectId: 'demo-hosted' });
        const { user } = await signInAnonymously(getAuth(app));
        const reference = doc(getFirestore(app), 'profiles', user.uid);
        await setDoc(reference, { message: 'Before' });
        document.querySelector('#uid').textContent = user.uid;
        onSnapshot(reference, snapshot => {
          const message = snapshot.data()?.message ?? 'Missing';
          document.querySelector('#current').textContent = message;
          const event = document.createElement('li');
          event.textContent = message;
          document.querySelector('#events').append(event);
        }, error => { document.querySelector('#error').textContent = error.code; });
      `,
    },
  });
  const context = await browser.newContext();
  const secondCut = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let interruptsRestore = false;
  let holdsAdmission = false;
  let cutConnection: (() => Promise<void>) | undefined;
  let replacement: ReturnType<typeof startHost> | undefined;
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      route.onMessage(async data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        if (isFrame) {
          const waitsForResume = holdsAdmission && frame.type === 'attach';
          if (waitsForResume) await resume.promise;
          const isWorkerMessage = frame.type === 'worker-message';
          if (isWorkerMessage) {
            const message = frame.message;
            const cutsRestoration = interruptsRestore && message.t === 'op' && message.method === 'auth.restorePortSession';
            if (cutsRestoration) {
              interruptsRestore = false;
              holdsAdmission = true;
              await route.close({ code: 1001, reason: 'Interrupted Auth restoration' });
              await server.close();
              secondCut.resolve();
              return;
            }
            const startsDocumentListener = message.t === 'sub' && typeof message.target === 'object';
            if (startsDocumentListener) {
              cutConnection = async () => {
                interruptsRestore = true;
                await route.close({ code: 1001, reason: 'First interruption' });
                await server.close();
              };
            }
          }
        }
        server.send(data);
      });
      server.onMessage(data => route.send(data));
    });
    const page = await context.newPage();
    await page.goto(fixture.info.url);
    await expect(page.locator('#current')).toHaveText('Before');
    const uid = await page.locator('#uid').innerText();
    const cut = cutConnection;
    const hasNoConnection = cut === undefined;
    if (hasNoConnection) throw new Error('Expected the original document subscription');
    await cut();
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    replacement = startHost(fixture.dir, fixture.info.port);
    expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    await secondCut.promise;
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'setDoc', path: `profiles/${uid}`,
        data: { message: 'After second cut' }, actAs: { mode: 'admin' } });
      holdsAdmission = false;
      resume.resolve();
      await expect(page.locator('#current')).toHaveText('After second cut');
      const restoredUid = await page.evaluate(async () => {
        const { getAuth } = await import('firebase/auth');
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        const user = getAuth().currentUser;
        const isSignedOut = user === null;
        if (isSignedOut) throw new Error('Expected the original identity');
        await setDoc(doc(getFirestore(), 'profiles', user.uid), { message: 'Final' });
        return user.uid;
      });
      expect(restoredUid).toBe(uid);
      await expect(page.locator('#current')).toHaveText('Final');
      await expect(page.locator('#events li')).toHaveText(['Before', 'After second cut', 'Final']);
      await expect(page.locator('#error')).toBeEmpty();
      expect(await control.auth.listUsers()).toHaveLength(1);
    } finally {
      control.close();
    }
  } finally {
    resume.resolve();
    await context.close();
    await replacement?.stop();
    await fixture.stop();
  }
});
