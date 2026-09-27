/**
 * A page holds one event-stream subscription per port and shares it among its
 * local subscribers. The host replays its whole history to each event
 * subscription it receives, so the port receives that replay once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import * as client from '../../../src/serve/worker/client.js';
import { restoreObservationSubscriptions } from '../../../src/serve/worker/client/core.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { connectClient, sleep } from './integration-support.js';

type Db = ReturnType<typeof client.getFirestore>;

/** Record every message the page posts to the host from now on. */
function recordPosts(db: Db): InboundMessage[] {
  const posted: InboundMessage[] = [];
  const port = db.port;
  const post = port.postMessage.bind(port);
  port.postMessage = (message: InboundMessage) => {
    posted.push(message);
    post(message);
  };
  return posted;
}

const eventSubs = (posted: InboundMessage[]) =>
  posted.filter((m) => m.t === 'sub' && (m as { target?: unknown }).target === 'events');
const unsubs = (posted: InboundMessage[]) => posted.filter((m) => m.t === 'unsub');

async function seed(ctx: Awaited<ReturnType<typeof connectClient>>['ctx'], id: string): Promise<void> {
  const { getAdminFirestore, doc, setDoc } = await import('pyric/firestore');
  await setDoc(doc(getAdminFirestore(ctx.sandbox), `seed/${id}`), { id });
}

describe('event subscriptions share one stream per port', () => {
  let restoreSW: () => void;
  beforeEach(() => {
    const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = prev; };
  });
  afterEach(() => restoreSW());

  it('four subscribers post one event subscription and each receives the history', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const historyLength = ctx.sandbox.history().length;
    const posted = recordPosts(db);

    const firstBatchLengths: number[] = [];
    const unsubscribers = [0, 1, 2, 3].map((i) => client.subscribeEvents(db, (events) => {
      if (firstBatchLengths[i] === undefined) firstBatchLengths[i] = events.length;
    }));
    await sleep();

    expect(eventSubs(posted)).toHaveLength(1);
    expect(firstBatchLengths).toEqual([historyLength, historyLength, historyLength, historyLength]);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  it('a subscriber added after the history arrives receives it from the page, and live events reach everyone', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const posted = recordPosts(db);

    const early: SandboxEvent[][] = [];
    const unsubscribeEarly = client.subscribeEvents(db, (events) => early.push([...events]));
    await sleep();
    const historyIds = early[0]!.map((e) => e.id);

    const late: SandboxEvent[][] = [];
    const unsubscribeLate = client.subscribeEvents(db, (events) => late.push([...events]));
    await sleep();
    expect(eventSubs(posted)).toHaveLength(1);
    expect(late[0]!.map((e) => e.id)).toEqual(historyIds);

    await seed(ctx, 'b');
    await sleep();
    const liveEarly = early.slice(1).flat().map((e) => e.id);
    const liveLate = late.slice(1).flat().map((e) => e.id);
    expect(liveEarly.length).toBeGreaterThan(0);
    expect(liveLate).toEqual(liveEarly);

    unsubscribeEarly();
    unsubscribeLate();
  });

  it('the stream closes when its last subscriber leaves, and the next subscriber opens a new one', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const posted = recordPosts(db);

    const first = client.subscribeEvents(db, () => {});
    const second = client.subscribeEvents(db, () => {});
    await sleep();
    first();
    expect(unsubs(posted)).toHaveLength(0);
    second();
    expect(unsubs(posted)).toHaveLength(1);

    let received = -1;
    const third = client.subscribeEvents(db, (events) => { if (received === -1) received = events.length; });
    await sleep();
    expect(eventSubs(posted)).toHaveLength(2);
    expect(received).toBe(ctx.sandbox.history().length);
    third();
  });

  it('eventHistory resolves with the history without closing a live subscriber', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const posted = recordPosts(db);

    const batches: number[] = [];
    const unsubscribe = client.subscribeEvents(db, (events) => batches.push(events.length));
    await sleep();
    const history = await client.eventHistory(db);
    expect(history.length).toBe(ctx.sandbox.history().length);
    expect(unsubs(posted)).toHaveLength(0);

    await seed(ctx, 'b');
    await sleep();
    expect(batches.length).toBeGreaterThan(1);
    unsubscribe();
  });

  it('a subscriber that joins after a reset receives only the history since the reset', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'before');
    const unsubscribeEarly = client.subscribeEvents(db, () => {});
    await sleep();

    ctx.sandbox.reset();
    await seed(ctx, 'after');
    await sleep();
    const hostHistoryIds = ctx.sandbox.history().map((e) => e.id);

    let lateHistory: SandboxEvent[] | undefined;
    const unsubscribeLate = client.subscribeEvents(db, (events) => { lateHistory ??= [...events]; });
    await sleep();
    expect(lateHistory!.map((e) => e.id)).toEqual(hostHistoryIds);
    expect(lateHistory!.some((e) => e.kind === 'session_boundary')).toBe(false);
    unsubscribeEarly();
    unsubscribeLate();
  });

  it('restoring the port re-sends one subscription, and its history replaces the page copy', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const unsubscribers = [0, 1, 2, 3].map(() => client.subscribeEvents(db, () => {}));
    await sleep();
    const posted = recordPosts(db);

    // A replacement host starts with its own history; stand one in by clearing this host's.
    (ctx.sandbox as unknown as { eventHistory: { clear(): void } }).eventHistory.clear();
    restoreObservationSubscriptions(db.port);
    await sleep();
    expect(eventSubs(posted)).toHaveLength(1);
    expect(unsubs(posted)).toHaveLength(1);

    let lateHistory: SandboxEvent[] | undefined;
    const late = client.subscribeEvents(db, (events) => { lateHistory ??= [...events]; });
    await sleep();
    expect(lateHistory!.map((e) => e.id)).toEqual(ctx.sandbox.history().map((e) => e.id));
    expect(lateHistory!.some((e) => e.kind === 'operation' && JSON.stringify(e).includes('seed/a'))).toBe(false);
    for (const unsubscribe of [...unsubscribers, late]) unsubscribe();
  });

  it('a subscriber removed during a delivery does not receive that batch', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    let secondBatches = 0;
    let unsubscribeSecond = () => {};
    const unsubscribeFirst = client.subscribeEvents(db, () => { unsubscribeSecond(); });
    unsubscribeSecond = client.subscribeEvents(db, () => { secondBatches++; });
    await sleep();
    expect(secondBatches).toBe(0);
    unsubscribeFirst();
  });

  it('a subscriber that throws does not stop the others from receiving the batch', async () => {
    const { ctx, db } = await connectClient();
    await seed(ctx, 'a');
    const reported: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { reported.push(args); };
    try {
      const received: number[] = [];
      const throwing = client.subscribeEvents(db, () => { throw new Error('consumer failed'); });
      const healthy = client.subscribeEvents(db, (events) => received.push(events.length));
      await sleep();
      expect(received[0]).toBe(ctx.sandbox.history().length);
      expect(reported.some((args) => (args[1] as Error)?.message === 'consumer failed')).toBe(true);
      throwing();
      healthy();
    } finally {
      console.error = consoleError;
    }
  });
});
