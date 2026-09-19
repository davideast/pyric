import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import { execFileSync } from 'node:child_process';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

function residentBytes(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024;
}

test('a stalled event reader is bounded and isolated from healthy SDK writes', async ({ page }) => {
  const fixture = await startHostedFixture();
  const readers: WebSocket[] = [];
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const pid = fixture.child.pid;
    const missingPid = pid === undefined;
    if (missingPid) throw new Error('Host PID is unavailable');
    const baseline = residentBytes(pid);
    for (const cycle of [0, 1]) {
      const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      readers.push(socket);
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<{ code: number; reason: string }>();
      socket.on('error', () => undefined);
      socket.once('close', (code, reason) => closed.resolve({ code, reason: reason.toString() }));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' })));
      socket.on('message', data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        const isAttached = isFrame && frame.type === 'attach-ack';
        if (isAttached) socket.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: 'slow', target: 'events' } }));
        const isEvents = isFrame && frame.type === 'worker-message-result' && frame.message.t === 'event';
        if (isEvents) ready.resolve();
      });
      await ready.promise;
      socket.pause();
      const times = await page.evaluate(async cycle => {
        const sdk = await import('firebase/firestore');
        const target = sdk.doc(sdk.getFirestore(), 'load', 'replaced');
        const padding = 'x'.repeat(256 * 1024);
        const times: number[] = [];
        for (const i of Array(192).keys()) {
          const start = performance.now();
          await sdk.setDoc(target, { padding, sequence: `${cycle}:${i}` });
          times.push(performance.now() - start);
        }
        return times;
      }, cycle);
      socket.resume();
      const outcome = await Promise.race([closed.promise, new Promise<null>(resolve => setTimeout(() => resolve(null), 3_000))]);
      const ordered = [...times].sort((a, b) => a - b);
      const p95 = ordered[Math.floor(ordered.length * 0.95)];
      console.log({ cycle, p95, maximum: Math.max(...times), rssGrowth: residentBytes(pid) - baseline, outcome });
      expect(outcome).toEqual({ code: 1013, reason: 'Client output backlog exceeds 24 MiB; reconnect to resume.' });
      expect(p95).toBeLessThan(1_000);
      expect(Math.max(...times)).toBeLessThan(2_000);
      expect(residentBytes(pid) - baseline).toBeLessThan(192 * 1024 * 1024);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
    }
  } finally {
    for (const socket of readers) socket.terminate();
    await page.close();
    await fixture.stop();
  }
});
