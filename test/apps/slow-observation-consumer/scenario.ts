// Ledger D7 (#1385): a slow observation consumer over a real backpressured TCP
// socket receives an `observation_gap` instead of being closed with 1013,
// completes an operation while backpressured, and leaves a healthy sibling
// consumer completely unaffected.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep, type AppProcess } from '../driver.ts';
import { get } from '../peer-client.ts';
import { openRawWsClient, type RawWsClient } from './raw-ws-client.ts';

interface ObservationEvent {
  kind: string;
  id: string;
  path?: string;
  omittedCount?: number;
  firstEventId?: string;
  lastEventId?: string;
  reason?: string;
}

function extractStreamEvents(messages: readonly unknown[]): ObservationEvent[] {
  const out: ObservationEvent[] = [];
  for (const raw of messages) {
    const frame = raw as {
      type?: string;
      message?: { t?: string; events?: ObservationEvent[] };
    };
    if (frame.type === 'worker-message-result' && frame.message?.t === 'event') {
      for (const ev of frame.message.events ?? []) {
        out.push(ev);
      }
    }
  }
  return out;
}

function isOpReply(raw: unknown, id: string): raw is {
  type: 'worker-message-result';
  message: { t: 'res'; id: string; ok: boolean; value?: unknown };
} {
  const frame = raw as {
    type?: string;
    message?: { t?: string; id?: string };
  };
  return (
    frame.type === 'worker-message-result' &&
    frame.message?.t === 'res' &&
    frame.message.id === id
  );
}

function hasWriteForPath(raw: unknown, targetPath: string): boolean {
  const events = extractStreamEvents([raw]);
  return events.some(ev => ev.kind === 'write' && ev.path === targetPath);
}

async function waitForHostReady(
  port: number,
  appDir: string,
  child: AppProcess,
): Promise<void> {
  const pointerPath = join(appDir, '.pyric', 'serve.json');
  const deadline = Date.now() + 60_000;
  for (;;) {
    assert.ok(
      child.running,
      `pyric sandbox exited before finishing startup:\n${child.output}`,
    );
    const hasBanner =
      existsSync(pointerPath) && child.output.includes('PYRIC_SANDBOX=remote');
    if (hasBanner) {
      try {
        const res = await get({
          address: '127.0.0.1',
          port,
          path: '/__pyric/init.json',
          host: `127.0.0.1:${port}`,
        });
        if (res.status === 200) return;
      } catch {
        // Host not listening yet.
      }
    }
    assert.ok(
      Date.now() < deadline,
      `pyric sandbox did not finish starting within 60s:\n${child.output}`,
    );
    await sleep(200);
  }
}

async function attachConsumer(port: number, label: string, subscribeEvents: boolean): Promise<RawWsClient> {
  const client = await openRawWsClient(port);
  client.sendJson({
    type: 'attach',
    protocol: 1,
    transport: 'worker-port',
    clientInfo: { platform: 'studio', deviceLabel: label },
  });
  await client.waitFor(msg => (msg as { type?: string }).type === 'attach-ack');
  if (subscribeEvents) {
    client.sendJson({
      type: 'worker-message',
      message: { t: 'sub', subId: `obs-${label}`, target: 'events' },
    });
    await client.waitFor(
      msg =>
        (msg as { type?: string; message?: { t?: string } }).type === 'worker-message-result' &&
        (msg as { message?: { t?: string } }).message?.t === 'event',
    );
  }
  return client;
}

export default scenario(async (app) => {
  const port = await app.freePort();
  let sandbox: AppProcess | undefined;

  await app.step('start pyric sandbox --hosted', async () => {
    const child = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ]);
    sandbox = child;
    await waitForHostReady(port, app.dir, child);
  });

  let slow: RawWsClient | undefined;
  let healthy: RawWsClient | undefined;
  let writer: RawWsClient | undefined;

  try {
    await app.step('connect slow, healthy, and writer consumers and verify live stream', async () => {
      slow = await attachConsumer(port, 'slow', true);
      healthy = await attachConsumer(port, 'healthy', true);
      writer = await attachConsumer(port, 'writer', false);

      writer.sendJson({
        type: 'worker-message',
        message: {
          t: 'op',
          id: 'seed-before',
          method: 'admin.setDocument',
          path: 'items/before',
          data: { phase: 'before' },
        },
      });
      await writer.waitFor(msg => isOpReply(msg, 'seed-before'));
      await slow.waitFor(msg => hasWriteForPath(msg, 'items/before'));
      await healthy.waitFor(msg => hasWriteForPath(msg, 'items/before'));
      slow.messages.length = 0;
      healthy.messages.length = 0;
    });

    await app.step('pause slow consumer TCP reads and flood > 28 MiB / > 1,100 writes', async () => {
      assert.ok(slow && healthy && writer);
      slow.socket.pause();

      // 1,150 writes with ~26 KiB documents produce > 30 MiB of serialized
      // observation frames (crossing the old 24 MiB 1013 close threshold AND
      // both 1,000-event / 16 MiB per-consumer observation bounds).
      const payloadText = 'x'.repeat(26 * 1024);
      const totalWrites = 1_150;
      for (let i = 0; i < totalWrites; i += 1) {
        const id = `flood-${i}`;
        writer.sendJson({
          type: 'worker-message',
          message: {
            t: 'op',
            id,
            method: 'admin.setDocument',
            path: `items/flood-${i}`,
            data: { index: i, body: payloadText },
          },
        });
        if (i % 100 === 99) {
          await writer.waitFor(msg => isOpReply(msg, id));
          writer.messages.length = 0;
        }
      }
      await writer.waitFor(msg => isOpReply(msg, `flood-${totalWrites - 1}`));
      await healthy.waitFor(msg => hasWriteForPath(msg, `items/flood-${totalWrites - 1}`), 30_000);
    });

    await app.step('issue an operation on the stalled consumer while backpressured, then resume and verify gap + op completion', async () => {
      assert.ok(slow && healthy && writer);
      assert.equal(slow.closeEvent, null, 'slow consumer was closed while stalled');
      assert.equal(healthy.closeEvent, null, 'healthy consumer was closed');

      // Healthy consumer received every write event with zero gaps.
      const healthyEvents = extractStreamEvents(healthy.messages);
      const healthyGaps = healthyEvents.filter(ev => ev.kind === 'observation_gap');
      assert.equal(healthyGaps.length, 0, 'healthy sibling consumer saw an unexpected observation_gap');
      const healthyWrites = healthyEvents.filter(ev => ev.kind === 'write');
      assert.equal(healthyWrites.length, 1_150);

      // Send an operation from `slow` while its inbound socket is still paused.
      slow.sendJson({
        type: 'worker-message',
        message: {
          t: 'op',
          id: 'op-while-stalled',
          method: 'admin.getDocument',
          path: 'items/flood-1149',
        },
      });
      await sleep(150);
      assert.equal(slow.closeEvent, null, 'slow consumer closed during stalled operation');

      // Resume `slow` so its TCP buffer and host observation queue drain.
      slow.socket.resume();

      const opReply = (await slow.waitFor(msg => isOpReply(msg, 'op-while-stalled'), 30_000)) as {
        message: { ok: boolean; value?: { index?: number } };
      };
      assert.equal(opReply.message.ok, true);
      assert.equal(opReply.message.value?.index, 1_149);

      await slow.waitFor(msg => hasWriteForPath(msg, 'items/flood-1149'), 30_000);
      assert.equal(slow.closeEvent, null, 'slow consumer closed while draining');

      const slowEvents = extractStreamEvents(slow.messages);
      const slowGaps = slowEvents.filter(ev => ev.kind === 'observation_gap');
      assert.ok(slowGaps.length >= 1, 'expected stalled consumer to receive observation_gap');
      for (const gap of slowGaps) {
        assert.equal(gap.reason, 'frame-limit');
        assert.ok((gap.omittedCount ?? 0) > 0, 'expected omittedCount > 0');
        assert.equal(typeof gap.firstEventId, 'string');
        assert.equal(typeof gap.lastEventId, 'string');
      }

      // Post-drain write reaches both consumers cleanly with no new gaps.
      const gapsBeforePostDrain = slowGaps.length;
      writer.sendJson({
        type: 'worker-message',
        message: {
          t: 'op',
          id: 'after-drain',
          method: 'admin.setDocument',
          path: 'items/after-drain',
          data: { done: true },
        },
      });
      await slow.waitFor(msg => hasWriteForPath(msg, 'items/after-drain'));
      await healthy.waitFor(msg => hasWriteForPath(msg, 'items/after-drain'));
      const gapsAfterPostDrain = extractStreamEvents(slow.messages).filter(
        ev => ev.kind === 'observation_gap',
      ).length;
      assert.equal(gapsAfterPostDrain, gapsBeforePostDrain);
    });
  } finally {
    slow?.close();
    healthy?.close();
    writer?.close();
    await sandbox?.stop();
  }
});
