import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { startSoakServe, waitForPeer } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

const invalidProtocols = [999, 0, undefined, null, '1', true, [], {}];

async function expectProtocolRefusal(url: string, handshake: unknown): Promise<void> {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  const messages: string[] = [];
  let closeCode = 0;
  let closeReason = '';
  socket.addEventListener('close', event => {
    closeCode = event.code;
    closeReason = event.reason;
  });
  socket.addEventListener('message', event => { messages.push(event.data); });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify(handshake));
    await expect.poll(() => closeCode).toBe(1008);
    expect(closeReason).toBe('Unsupported bridge protocol. Expected version 1.');
    expect(messages).toEqual([]);
  } finally {
    socket.close();
  }
}

test('an unsupported consumer protocol is refused without interrupting a supported app', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
    for (const transport of ['worker-port', undefined]) {
      for (const protocol of invalidProtocols) {
        await expectProtocolRefusal(fixture.info.url, { type: 'attach', protocol, transport });
      }
    }
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await context.close();
    await fixture.stop();
  }
});

const refusedFrames = [
  { name: 'protocol refusal', code: 1008, frame: JSON.stringify({ type: 'attach', protocol: 999, transport: 'worker-port' }) },
  { name: 'invalid session grant', code: 1008, frame: JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port', resumeToken: 'not-issued' }) },
  { name: 'invalid JSON', code: 1002, frame: '{' },
];

for (const refusal of refusedFrames) {
  test(`buffered frames cannot admit or mutate after ${refusal.name}`, async ({ page }) => {
    test.setTimeout(30_000);
    const fixture = await startHostedFixture();
    const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    let closeCode = 0;
    socket.addEventListener('close', event => { closeCode = event.code; });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      socket.send(refusal.frame);
      socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' }));
      socket.send(JSON.stringify({ type: 'worker-message', message: {
        t: 'op', id: 'forbidden-write', method: 'setDoc', path: 'shared/greeting',
        data: { message: 'Admitted after refusal' }, actAs: { mode: 'admin' },
      } }));
      await expect.poll(() => closeCode).toBe(refusal.code);
      const exists = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        return (await getDoc(doc(getFirestore(), 'shared/greeting'))).exists();
      });
      expect(exists).toBe(false);
      await expect(page.locator('#document')).toHaveText('Empty');
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
    } finally {
      socket.close();
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}

test('an unsupported peer protocol cannot replace the default SharedWorker peer', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
    await waitForPeer(fixture.info.url);
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      for (const protocol of invalidProtocols) {
        await expectProtocolRefusal(fixture.info.url, { type: 'hello', protocol, tools: [], sandboxId: 'incompatible-peer' });
      }
      await control.channel.op({ method: 'setDoc', path: 'shared/greeting', data: { message: 'Still connected' }, actAs: { mode: 'admin' } });
      await expect(page.locator('#document')).toHaveText('Still connected');
    } finally {
      control.close();
    }
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await page.close();
    await fixture.stop();
  }
});
