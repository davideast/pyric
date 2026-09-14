import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test, type Page } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

const invalidIds = [null, undefined, 7, false, [], {}];
const invalidContainers = [null, undefined, 7, false, [], 'invalid'];

const write = {
  method: 'setDoc', path: 'shared/greeting', data: { message: 'Uncorrelated write' }, actAs: { mode: 'admin' },
};
const subscription = { target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' } };

test('legacy writes with malformed correlation IDs refuse before mutation', async ({ page }) => {
  await assertRelayRefusals(page, invalidIds.map(id => ({ type: 'worker-op', id, op: write })));
});

test('legacy subscriptions with malformed correlation IDs refuse before registration', async ({ page }) => {
  await assertRelayRefusals(page, invalidIds.map(subId => ({ type: 'worker-sub', subId, sub: subscription })));
});

test('malformed legacy operation bodies refuse before dispatch', async ({ page }) => {
  const bodies = [...invalidContainers, {}, { method: 7 }, { method: null }, { method: [] }, { method: {} }];
  await assertRelayRefusals(page, bodies.map(op => ({ type: 'worker-op', id: 'invalid-body', op })));
});

test('malformed legacy subscription bodies refuse before registration', async ({ page }) => {
  const bodies = [...invalidContainers, {}, { target: 7 }, { target: null }, { target: [] }, { target: false }];
  await assertRelayRefusals(page, bodies.map(sub => ({ type: 'worker-sub', subId: 'invalid-body', sub })));
});

test('legacy unsubscribe with malformed correlation IDs refuses the frame', async ({ page }) => {
  await assertRelayRefusals(page, invalidIds.map(subId => ({ type: 'worker-unsub', subId })));
});

/** Keep a normal app active while independent malformed consumers are refused. */
async function assertRelayRefusals(page: Page, invalidFrames: unknown[]): Promise<void> {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
    for (const invalidFrame of invalidFrames) {
      await refuseRelayFrame(fixture.info.url, invalidFrame);
      const exists = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        return (await getDoc(doc(getFirestore(), 'shared/greeting'))).exists();
      });
      expect(exists).toBe(false);
      await expect(page.locator('#document')).toHaveText('Empty');
    }
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
        data: { message: 'Reattached control' }, actAs: { mode: 'admin' } });
      await expect(page.locator('#document')).toHaveText('Reattached control');
    } finally {
      control.close();
    }
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await page.close();
    await fixture.stop();
  }
}

async function refuseRelayFrame(url: string, invalidFrame: unknown): Promise<void> {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  let attached = false;
  let outcome: number | string = 'pending';
  const replies: string[] = [];
  socket.addEventListener('close', event => { outcome = event.code; });
  socket.addEventListener('message', event => {
    const frame: unknown = JSON.parse(event.data);
    const acknowledgesAttach = isBridgeMessage(frame) && frame.type === 'attach-ack';
    if (acknowledgesAttach) {
      attached = true;
      return;
    }
    replies.push(event.data);
    outcome = event.data;
  });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    await expect.poll(() => attached).toBe(true);
    socket.send(JSON.stringify(invalidFrame));
    await expect.poll(() => outcome, { message: JSON.stringify(invalidFrame) }).not.toBe('pending');
    expect(outcome).toBe(1002);
    expect(replies).toEqual([]);
  } finally {
    socket.close();
  }
}
