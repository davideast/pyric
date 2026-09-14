import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type AuthLens, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe } from '../soak/harness.js';

const invalidIds = [null, 42, false, [], {}];
const invalidLenses = [
  null, undefined, 42, false, [], 'anon', {}, { mode: 'invalid' }, { mode: 42 },
  { mode: 'as' }, { mode: 'as', uid: '' }, { mode: 'as', uid: 42 },
  { mode: 'as', uid: 'alice', tenant: '' }, { mode: 'as', uid: 'alice', tenant: null },
  { mode: 'as', uid: 'alice', tenant: 42 }, { mode: 'as', uid: 'alice', tenant: [] },
  { mode: 'as', uid: 'alice', token: null }, { mode: 'as', uid: 'alice', token: 42 },
  { mode: 'as', uid: 'alice', token: [] }, { mode: 'as', uid: 'alice', token: 'claims' },
];
const invalidFrames: Record<string, unknown>[] = [
  ...invalidLenses.map(lens => ({ lens })),
  ...invalidIds.map(id => ({ id })),
  ...[...invalidIds, undefined].map(clientSessionId => ({ clientSessionId })),
];
const supportedLenses: AuthLens[] = [
  { mode: 'admin' }, { mode: 'anon' }, { mode: 'app-session' }, { mode: 'as', uid: 'alice' },
  { mode: 'as', uid: 'alice', tenant: 'tenant-blue', token: { role: 'editor' } },
];

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} validates remote identity lenses before mutation and preserves supported modes`, async ({ page }) => {
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
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      for (const invalidFrame of invalidFrames) {
        await refuseLensRequest(fixture.info.url, invalidFrame);
        const exists = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).exists();
        });
        expect(exists).toBe(false);
      }
      for (const lens of supportedLenses) {
        await acceptLensRequest(fixture.info.url, lens, 'valid-lens');
      }
      await acceptLensRequest(fixture.info.url, { mode: 'anon' }, undefined);
      await expect(page.locator('#document')).toHaveText('Empty');
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      expect(pageErrors).toEqual([]);
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}

async function connectLensConsumer(url: string) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  const state = { clientSessionId: '', closeCode: 0 };
  const replies: BridgeMessage[] = [];
  socket.addEventListener('close', event => { state.closeCode = event.code; });
  socket.addEventListener('message', event => {
    const frame: unknown = JSON.parse(event.data);
    const isUnknownFrame = !isBridgeMessage(frame);
    if (isUnknownFrame) throw new Error('Received an unrecognised bridge frame');
    const acknowledgesAttach = frame.type === 'attach-ack';
    if (acknowledgesAttach) {
      state.clientSessionId = frame.clientSessionId;
      return;
    }
    replies.push(frame);
  });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    await expect.poll(() => state.clientSessionId).not.toBe('');
    return { socket, state, replies };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function refuseLensRequest(url: string, changes: Record<string, unknown>): Promise<void> {
  const consumer = await connectLensConsumer(url);
  try {
    consumer.socket.send(JSON.stringify({ type: 'remote-set-lens', id: 'invalid-lens',
      clientSessionId: consumer.state.clientSessionId, lens: { mode: 'anon' }, ...changes }));
    consumer.socket.send(JSON.stringify({ type: 'worker-op', id: 'buffered-write', op: {
      method: 'setDoc', path: 'shared/greeting', data: { message: 'Write after malformed lens' }, actAs: { mode: 'admin' },
    } }));
    await expect.poll(() => consumer.state.closeCode, { message: JSON.stringify(changes) }).toBe(1002);
    expect(consumer.replies).toEqual([]);
  } finally {
    consumer.socket.close();
  }
}

async function acceptLensRequest(url: string, lens: AuthLens, id: string | undefined): Promise<void> {
  const consumer = await connectLensConsumer(url);
  const clientSessionId = consumer.state.clientSessionId;
  try {
    consumer.socket.send(JSON.stringify({ type: 'remote-set-lens', id, clientSessionId, lens }));
    await expect.poll(() => consumer.replies).toContainEqual({ type: 'worker-event', event: 'remote-lens', clientSessionId, lens });
    const requestsAcknowledgment = id !== undefined;
    if (requestsAcknowledgment) {
      await expect.poll(() => consumer.replies).toContainEqual({ type: 'remote-set-lens-ack', id, clientSessionId, ok: true });
    }
    expect(consumer.state.closeCode).toBe(0);
  } finally {
    consumer.socket.close();
  }
}
