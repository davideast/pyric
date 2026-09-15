import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import type { SandboxEvent } from 'pyric/sandbox';
import { readFileSync } from 'node:fs';
import { startSoakServe } from '../soak/harness.js';

for (const limit of ['bytes', 'count'] as const) {
test(`late event consumers receive ${limit}-bounded history and subsequent live events`, async ({ page }) => {
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    'firestore.rules': 'service cloud.firestore { match /databases/{db}/documents { match /load/{id} { allow read, write: if true; } match /shared/{id} { allow read, write: if true; } } }',
  } });
  let socket: WebSocket | undefined;
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async limit => {
      const sdk = await import('firebase/firestore');
      const target = sdk.doc(sdk.getFirestore(), 'load', 'history');
      const testsBytes = limit === 'bytes';
      if (testsBytes) {
        for (const sequence of Array(48).keys()) {
          await sdk.setDoc(target, { sequence, padding: 'x'.repeat(256 * 1024) });
        }
      } else {
        for (const batch of Array(70).keys()) {
          await Promise.all(Array.from({ length: 50 }, async (_, index) => {
            const observed = sdk.doc(sdk.getFirestore(), 'load', `${batch}:${index}`);
            const initial = Promise.withResolvers<void>();
            const stop = sdk.onSnapshot(observed, () => initial.resolve(), initial.reject);
            const timeout = setTimeout(() => initial.reject(new Error(`Listener ${batch}:${index} did not deliver its initial snapshot`)), 3_000);
            try { await initial.promise; } finally { clearTimeout(timeout); stop(); }
          }));
        }
        await sdk.setDoc(target, { sequence: 'latest' });
      }
    }, limit);
    console.log(`${limit} workload finished`);
    const history = Promise.withResolvers<readonly SandboxEvent[]>();
    const live = Promise.withResolvers<void>();
    socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    const consumer = socket;
    consumer.on('error', history.reject);
    consumer.once('open', () => consumer.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' })));
    consumer.on('message', data => {
      const frame: unknown = JSON.parse(data.toString());
      const isFrame = isBridgeMessage(frame);
      const isAttached = isFrame && frame.type === 'attach-ack';
      if (isAttached) consumer.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: 'history', target: 'events' } }));
      const isWorkerReply = isFrame && frame.type === 'worker-message-result';
      if (isWorkerReply) {
        const message = frame.message;
        const isEvents = message.t === 'event';
        if (isEvents) {
          history.resolve(message.events);
          const hasNewWrite = message.events.some(event => event.kind === 'write' && event.path === 'shared/greeting');
          if (hasNewWrite) live.resolve();
        }
      }
    });
    const events = await history.promise;
    console.log({ limit, retained: events.length, bytes: Buffer.byteLength(JSON.stringify(events)) });
    expect(events[0]).toMatchObject({ kind: 'observation_gap', reason: 'history-limit' });
    expect(events.length).toBeLessThanOrEqual(10_001);
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(events.some(event => event.kind === 'write')).toBe(true);
    const testsCount = limit === 'count';
    if (testsCount) expect(events.length).toBe(10_001);
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await live.promise;
  } finally {
    socket?.terminate();
    await page.close();
    await fixture.stop();
  }
});

}
