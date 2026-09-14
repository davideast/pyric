import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

const frameLimit = 12 * 1024 * 1024;
const sizes = [
  { bytes: frameLimit - 1, fragmented: false, acceptsWrite: true },
  { bytes: frameLimit, fragmented: false, acceptsWrite: true },
  { bytes: frameLimit + 1, fragmented: false, acceptsWrite: false },
  { bytes: frameLimit, fragmented: true, acceptsWrite: true },
  { bytes: frameLimit + 1, fragmented: true, acceptsWrite: false },
];

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} applies the 12 MiB inbound limit to encoded and fragmented messages`, async ({ page }) => {
    test.setTimeout(30_000);
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      let expectedMessage = 'Empty';
      for (const size of sizes) {
        const message = `${size.bytes} bytes; fragmented ${size.fragmented}`;
        await checkFrame(fixture.info.url, size, message);
        const acceptsWrite = size.acceptsWrite;
        if (acceptsWrite) expectedMessage = message;
        const actual = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data()?.message;
        });
        expect(actual).toBe(expectedMessage);
        await expect(page.locator('#document')).toHaveText(expectedMessage);
      }
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}

async function checkFrame(url: string, size: { bytes: number; fragmented: boolean; acceptsWrite: boolean }, message: string): Promise<void> {
  const { fragmented, acceptsWrite } = size;
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  let attached = false;
  let outcome: number | boolean | 'pending' = 'pending';
  socket.addEventListener('close', event => { outcome = event.code; });
  socket.addEventListener('message', event => {
    const frame: unknown = JSON.parse(event.data.toString());
    const isKnownFrame = isBridgeMessage(frame);
    const acknowledgesAttach = isKnownFrame && frame.type === 'attach-ack';
    if (acknowledgesAttach) attached = true;
    const acknowledgesWrite = isKnownFrame && frame.type === 'worker-res';
    if (acknowledgesWrite) outcome = frame.ok;
  });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    await expect.poll(() => attached).toBe(true);
    const request = { type: 'worker-op', id: 'sized-frame', op: {
      method: 'setDoc', path: 'shared/greeting', data: { message }, actAs: { mode: 'admin' },
    }, padding: '' };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(request));
    const paddingBytes = size.bytes - envelopeBytes;
    request.padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
    const payload = JSON.stringify(request);
    expect(Buffer.byteLength(payload)).toBe(size.bytes);
    if (fragmented) {
      const midpoint = Math.floor(payload.length / 2);
      socket.send(payload.slice(0, midpoint), { fin: false });
      socket.send(payload.slice(midpoint), { fin: true });
    } else {
      socket.send(payload);
    }
    const expectedOutcome = acceptsWrite ? true : 1009;
    await expect.poll(() => outcome).toBe(expectedOutcome);
  } finally {
    socket.close();
  }
}
