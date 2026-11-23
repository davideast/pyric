import { afterEach, describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  getFirestore as workerGetFirestore,
  type ClientDb,
} from '@pyric/cli/serve/worker';
import { workerEventFeed } from '../../src/clients/worker-live.js';

function fakeWriteEvent(id: string): SandboxEvent {
  return {
    kind: 'write',
    id,
    at: 1,
    method: 'create',
    path: `items/${id}`,
    auth: null,
    priorState: null,
    nextState: {},
    requestTime: { seconds: 0, nanoseconds: 0 },
  } as SandboxEvent;
}

function installControllableWorker() {
  const globalRecord = globalThis as { SharedWorker?: unknown };
  const previousWorker = globalRecord.SharedWorker;
  const sent: Array<Record<string, unknown>> = [];
  const port = {
    sent,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: Record<string, unknown>) {
      sent.push(message);
    },
    start() {},
    addEventListener() {},
    close() {},
  };
  globalRecord.SharedWorker = class {
    port = port;
    constructor(_url: unknown, _options: unknown) {}
  };
  return {
    sent,
    deliver(payload: unknown) {
      port.onmessage?.({ data: payload });
    },
    restore() {
      globalRecord.SharedWorker = previousWorker;
    },
  };
}

function findEventsSubId(sent: ReadonlyArray<Record<string, unknown>>): string {
  const sub = sent.find((msg) => msg.t === 'sub' && msg.target === 'events');
  if (!sub || typeof sub.subId !== 'string') {
    throw new Error('Expected worker events subscription message');
  }
  return sub.subId;
}

describe('workerEventFeed subscriber isolation (#390)', () => {
  let restoreWorker: (() => void) | null = null;
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
    if (restoreWorker !== null) {
      restoreWorker();
      restoreWorker = null;
    }
  });

  it('isolates synchronous subscriber throws across both history batches and live events', () => {
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const sw = installControllableWorker();
    restoreWorker = sw.restore;
    const db: ClientDb = workerGetFirestore('worker://isolation-sync');
    const feed = workerEventFeed(db);

    const beforeThrower: string[] = [];
    const throwerSeen: string[] = [];
    const afterThrower: string[] = [];

    feed.subscribe((event) => {
      beforeThrower.push(event.id);
    });
    feed.subscribe((event) => {
      throwerSeen.push(event.id);
      if (event.id === 'h1' || event.id === 'l1') {
        throw new Error(`boom on ${event.id}`);
      }
    });
    feed.subscribe((event) => {
      afterThrower.push(event.id);
    });

    const subId = findEventsSubId(sw.sent);
    sw.deliver({
      t: 'event',
      subId,
      events: [fakeWriteEvent('h1'), fakeWriteEvent('h2')],
    });
    sw.deliver({
      t: 'event',
      subId,
      events: [fakeWriteEvent('l1')],
    });

    expect(beforeThrower).toEqual(['h1', 'h2', 'l1']);
    expect(throwerSeen).toEqual(['h1', 'h2', 'l1']);
    expect(afterThrower).toEqual(['h1', 'h2', 'l1']);
    expect(feed.history().map((event) => event.id)).toEqual(['h1', 'h2', 'l1']);
    expect(loggedErrors).toHaveLength(2);
  });

  it('absorbs async subscriber rejections and skips subscribers removed mid-delivery', async () => {
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    const sw = installControllableWorker();
    restoreWorker = sw.restore;
    const db: ClientDb = workerGetFirestore('worker://isolation-async');
    const feed = workerEventFeed(db);

    const lateSeen: string[] = [];
    let unsubLate: (() => void) | null = null;

    feed.subscribe((() => Promise.reject(new Error('async boom'))) as unknown as (
      event: SandboxEvent,
    ) => void);
    feed.subscribe((event) => {
      if (event.id === 'e1' && unsubLate !== null) {
        unsubLate();
      }
    });
    unsubLate = feed.subscribe((event) => {
      lateSeen.push(event.id);
    });

    const subId = findEventsSubId(sw.sent);
    sw.deliver({
      t: 'event',
      subId,
      events: [fakeWriteEvent('e1'), fakeWriteEvent('e2')],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(lateSeen).toEqual([]);
    expect(loggedErrors.length).toBeGreaterThanOrEqual(2);
  });
});
