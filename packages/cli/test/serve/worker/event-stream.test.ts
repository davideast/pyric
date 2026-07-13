/**
 * Tests for the SharedWorker host's EVENT-STREAM subscription
 * (Pyric Studio Wave 2.5a data plane).
 *
 * Strategy mirrors host.test.ts: a REAL pyric sandbox + fake MessagePort
 * objects, calling `handleMessage` directly — no SharedWorker runtime.
 *
 * Coverage:
 *   - subscribe-events delivers `sandbox.history()` immediately as the initial
 *     batch, then streams subsequent live events (each as a single-element batch).
 *   - multiple ports each get the fan-out (one sandbox, many subscribers).
 *   - unsubscribe stops delivery; cleanupPort drops a port's event subs.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  EventStreamMessage,
} from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

function fakePort(): PortLike & {
  messages: OutboundMessage[];
  events: EventStreamMessage[];
} {
  const messages: OutboundMessage[] = [];
  const events: EventStreamMessage[] = [];
  return {
    messages,
    events,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'event') events.push(msg);
    },
  };
}
type FakePort = ReturnType<typeof fakePort>;

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `test-worker-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  const db = getFirestore(sandbox);
  return { db, sandbox, subs: new Map() };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRes(port: FakePort, id: string): ResMessage | undefined {
  return port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
}

/** Flatten every event delivered to a port across all its batches. */
function flatEvents(port: FakePort) {
  return port.events.flatMap((m) => m.events);
}

describe('event-stream subscription', () => {
  let ctx: HostCtx;
  let port: FakePort;

  beforeEach(async () => {
    ctx = await makeCtx();
    port = fakePort();
  });

  it('delivers the history snapshot as the initial batch on subscribe', async () => {
    // Produce some events BEFORE subscribing (a request + a write).
    await handleMessage(ctx, port, {
      t: 'op', id: 'w1', method: 'setDoc', path: 'users/alice', data: { n: 1 },
    });
    expect(getRes(port, 'w1')!.ok).toBe(true);

    const historyLen = ctx.sandbox.history().length;
    expect(historyLen).toBeGreaterThan(0);

    // Now subscribe — the FIRST event message is the full history snapshot.
    const sub = fakePort();
    handleMessage(ctx, sub, { t: 'sub', subId: 'ev-1', target: 'events' });

    expect(sub.events.length).toBe(1);
    expect(sub.events[0]!.subId).toBe('ev-1');
    expect(sub.events[0]!.events.length).toBe(historyLen);
  });

  it('streams subsequent live events as single-element batches', async () => {
    const sub = fakePort();
    handleMessage(ctx, sub, { t: 'sub', subId: 'ev-1', target: 'events' });
    const initialBatches = sub.events.length; // 1 (history, empty)
    const baselineCount = flatEvents(sub).length;

    // A live write fires request + write events; they arrive AFTER the history.
    await handleMessage(ctx, sub, {
      t: 'op', id: 'w1', method: 'setDoc', path: 'users/bob', data: { n: 2 },
    });
    await tick();

    expect(sub.events.length).toBeGreaterThan(initialBatches);
    const liveBatches = sub.events.slice(initialBatches);
    // Each live batch carries exactly one event.
    for (const b of liveBatches) expect(b.events.length).toBe(1);
    expect(flatEvents(sub).length).toBeGreaterThan(baselineCount);
  });

  it('fans out live events to every subscribed port', async () => {
    const a = fakePort();
    const b = fakePort();
    handleMessage(ctx, a, { t: 'sub', subId: 'a', target: 'events' });
    handleMessage(ctx, b, { t: 'sub', subId: 'b', target: 'events' });

    const aBefore = flatEvents(a).length;
    const bBefore = flatEvents(b).length;

    await handleMessage(ctx, a, {
      t: 'op', id: 'w1', method: 'setDoc', path: 'users/carol', data: { n: 3 },
    });
    await tick();

    expect(flatEvents(a).length).toBeGreaterThan(aBefore);
    expect(flatEvents(b).length).toBeGreaterThan(bBefore);
  });

  it('stops delivery after unsubscribe', async () => {
    handleMessage(ctx, port, { t: 'sub', subId: 'ev-1', target: 'events' });
    handleMessage(ctx, port, { t: 'unsub', subId: 'ev-1' });

    const before = flatEvents(port).length;
    await handleMessage(ctx, port, {
      t: 'op', id: 'w1', method: 'setDoc', path: 'users/dave', data: { n: 4 },
    });
    await tick();
    expect(flatEvents(port).length).toBe(before);
  });

  it('cleanupPort drops the port event subscriptions', async () => {
    handleMessage(ctx, port, { t: 'sub', subId: 'ev-1', target: 'events' });
    cleanupPort(ctx, port);

    const before = flatEvents(port).length;
    const other = fakePort();
    await handleMessage(ctx, other, {
      t: 'op', id: 'w1', method: 'setDoc', path: 'users/erin', data: { n: 5 },
    });
    await tick();
    // The cleaned-up port receives nothing more.
    expect(flatEvents(port).length).toBe(before);
  });
});
