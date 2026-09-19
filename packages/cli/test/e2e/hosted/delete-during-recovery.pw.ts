import { once } from 'node:events';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('deleting an app during Auth restoration closes the connection and cancels recovery', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  const restoring = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let holdsRestoration = false;
  let appUid: string | undefined;
  let deletedSessionGrant: string | undefined;
  let restorationRequests = 0;
  let resumedDeletedSessions = 0;
  let replacement: ReturnType<typeof startHost> | undefined;
  try {
    await context.routeWebSocket('**/*', route => {
      const server = route.connectToServer();
      let isRestoringConnection = false;
      let sessionGrant: string | undefined;
      server.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        const acknowledgesAttach = isFrame && frame.type === 'attach-ack';
        if (acknowledgesAttach) sessionGrant = frame.resumeToken;
        route.send(data);
      });
      route.onClose(() => {
        server.close();
        if (isRestoringConnection) closed.resolve();
      });
      route.onMessage(data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        if (isFrame) {
          const resumesDeletedSession = frame.type === 'attach' && deletedSessionGrant !== undefined && frame.resumeToken === deletedSessionGrant;
          if (resumesDeletedSession) resumedDeletedSessions += 1;
          const isWorkerMessage = frame.type === 'worker-message';
          if (isWorkerMessage) {
            const message = frame.message;
            const restoresIdentity = message.t === 'op' && message.method === 'auth.restorePortSession';
            const delaysAuth = holdsRestoration && restoresIdentity && message.uid === appUid;
            if (delaysAuth) {
              restorationRequests += 1;
              deletedSessionGrant = sessionGrant;
              isRestoringConnection = true;
              restoring.resolve();
              return;
            }
          }
        }
        server.send(data);
      });
    });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    appUid = await page.evaluate(async () => (await import('firebase/auth')).getAuth().currentUser?.uid);
    expect(appUid).toEqual(expect.any(String));
    holdsRestoration = true;
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await exited;
    replacement = startHost(fixture.dir, fixture.info.port);
    expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    await restoring.promise;
    expect(deletedSessionGrant).toEqual(expect.any(String));
    const remainingApps = await page.evaluate(async () => {
      const { deleteApp, getApp, getApps } = await import('firebase/app');
      await deleteApp(getApp());
      return getApps().length;
    });
    expect(remainingApps).toBe(0);
    await closed.promise;
    const restoresAfterDeletion = restorationRequests;
    const resumesAfterDeletion = resumedDeletedSessions;
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
        data: { message: 'Must not reach the deleted app' }, actAs: { mode: 'admin' } });
      await page.clock.runFor(10_000);
      expect(restorationRequests).toBe(restoresAfterDeletion);
      expect(resumedDeletedSessions).toBe(resumesAfterDeletion);
      await expect(page.locator('#document')).not.toHaveText('Must not reach the deleted app');
      expect(await page.evaluate(async () => (await import('firebase/app')).getApps().length)).toBe(0);
    } finally {
      control.close();
    }
  } finally {
    await context.close();
    await replacement?.stop();
    await fixture.stop();
  }
});
