/**
 * Tests for the Studio live data plane (Wave 2.5a): `worker-live.ts` + the
 * `createStudioEnvironment('local')` live-plane gating.
 *
 * The full SharedWorker connection can only be proven in a real browser (the
 * orchestrator's smoke-test). These unit tests cover the layers that DON'T need
 * a real worker:
 *   - `connectWorkerLive()` returns null when no `SharedWorker` global exists
 *     (SSR / unsupported browser / tests): the HTTP-fallback contract.
 *   - the env factory omits `live` when there's no worker / `disableLive`, and
 *     surfaces a live plane (with an `EventFeed`-shaped feed + lens + policy
 *     setters) when a minimal `SharedWorker` is shimmed.
 *   - the env never throws in `local` mode regardless of worker availability.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { connectWorkerLive, workerEventFeed } from './worker-live.js';
import { createStudioEnvironment } from '../env.js';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  getFirestore as workerGetFirestore,
  type ClientDb,
} from 'pyric-tools/serve/worker';

/** Install a minimal SharedWorker shim whose port records postMessages but never
 *  replies, enough to exercise client construction + the live-plane shape
 *  without a real worker. Returns a restore fn. */
function shimSharedWorker(): () => void {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = {
      postMessage() {},
      start() {},
      onmessage: null as unknown,
      addEventListener() {},
    };
    constructor(_url: unknown, _opts: unknown) {}
  };
  return () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
  };
}

/** Force "no SharedWorker" regardless of the host environment. */
function removeSharedWorker(): () => void {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
  return () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
  };
}

describe('connectWorkerLive', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('returns null when no SharedWorker is available (HTTP-fallback contract)', () => {
    restore = removeSharedWorker();
    expect(connectWorkerLive()).toBeNull();
  });

  it('returns a live plane with feed + lens + policy seams when SharedWorker exists', () => {
    restore = shimSharedWorker();
    const plane = connectWorkerLive();
    expect(plane).not.toBeNull();
    expect(plane!.db.__kind).toBe('client-db');
    // The feed is `{ history, subscribe }`-shaped (an EventFeed).
    expect(typeof plane!.feed.history).toBe('function');
    expect(typeof plane!.feed.subscribe).toBe('function');
    expect(plane!.feed.history()).toEqual([]);
    // Lens + policy seams are present (the F2/F3/F4 affordances).
    expect(typeof plane!.setLens).toBe('function');
    expect(typeof plane!.getLens).toBe('function');
    expect(typeof plane!.setPolicy).toBe('function');
    expect(typeof plane!.getPolicy).toBe('function');
  });

  it('lens setter round-trips through the worker client module state', () => {
    restore = shimSharedWorker();
    const plane = connectWorkerLive()!;
    plane.setLens({ mode: 'as', uid: 'alice' });
    expect(plane.getLens()).toEqual({ mode: 'as', uid: 'alice' });
    plane.setLens({ mode: 'app-session' });
    // app-session is the default → reads back as undefined (no lens).
    expect(plane.getLens()).toBeUndefined();
  });
});

/**
 * A controllable SharedWorker shim: its port records outbound messages and
 * exposes `deliver()` to push a worker→client message into the wired
 * `onmessage` (the real client's `wirePort` attaches it). Lets us drive the
 * event-stream protocol against the REAL worker client without a real worker.
 */
function controllableSharedWorker(): {
  restore: () => void;
  port: {
    sent: unknown[];
    onmessage: ((ev: { data: unknown }) => void) | null;
  };
  deliver: (msg: unknown) => void;
} {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const port = {
    sent: [] as unknown[],
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: unknown) {
      port.sent.push(msg);
    },
    start() {},
    addEventListener() {},
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return {
    restore: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
    port,
    deliver: (msg) => port.onmessage?.({ data: msg }),
  };
}

function fakeWrite(id: string): SandboxEvent {
  return {
    kind: 'write',
    id,
    at: 0,
    method: 'create',
    path: `users/${id}`,
    auth: null,
    priorState: null,
    nextState: {},
    requestTime: { seconds: 0, nanoseconds: 0 },
  } as SandboxEvent;
}

describe('workerEventFeed (F1 live-feed adapter)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('delivers the history backlog then live events to an early subscriber', () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const db: ClientDb = workerGetFirestore('worker://test');
    const feed = workerEventFeed(db);

    // Subscribe BEFORE any worker batch arrives (the useActionDigest order):
    // history() is empty at this instant.
    expect(feed.history()).toEqual([]);
    const seen: string[] = [];
    const unsub = feed.subscribe((e) => seen.push(e.id));

    // The feed opened a worker sub: grab its subId from the posted message.
    const subMsg = sw.port.sent.find(
      (m): m is { t: 'sub'; subId: string; target: string } =>
        (m as { t?: string }).t === 'sub' &&
        (m as { target?: string }).target === 'events',
    );
    expect(subMsg).toBeDefined();
    const subId = subMsg!.subId;

    // Worker delivers the initial history batch (backlog): the early
    // subscriber must receive it (not silently drop it).
    sw.deliver({ t: 'event', subId, events: [fakeWrite('h1'), fakeWrite('h2')] });
    expect(seen).toEqual(['h1', 'h2']);
    // And a late history() now reflects the backlog.
    expect(feed.history().map((e) => e.id)).toEqual(['h1', 'h2']);

    // Subsequent live events stream through + accrete into history().
    sw.deliver({ t: 'event', subId, events: [fakeWrite('l1')] });
    expect(seen).toEqual(['h1', 'h2', 'l1']);
    expect(feed.history().map((e) => e.id)).toEqual(['h1', 'h2', 'l1']);

    unsub();
    // After the last unsubscribe, the worker sub is torn down (unsub posted).
    const unsubMsg = sw.port.sent.find(
      (m) => (m as { t?: string }).t === 'unsub',
    );
    expect(unsubMsg).toBeDefined();
  });
});

describe("createStudioEnvironment('local') live-plane gating", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('omits the live plane when no SharedWorker is present', () => {
    restore = removeSharedWorker();
    const env = createStudioEnvironment('local', { persistence: 'memory' });
    expect(env.mode).toBe('local');
    expect(env.live).toBeUndefined();
    // The HTTP-fallback ports are still wired.
    expect(env.projects).toBeDefined();
    expect(env.persistence).toBeDefined();
  });

  it('omits the live plane when disableLive is set, even with a SharedWorker', () => {
    restore = shimSharedWorker();
    const env = createStudioEnvironment('local', {
      persistence: 'memory',
      disableLive: true,
    });
    expect(env.live).toBeUndefined();
  });

  it('surfaces the live plane when a SharedWorker is available', () => {
    restore = shimSharedWorker();
    const env = createStudioEnvironment('local', { persistence: 'memory' });
    expect(env.live).toBeDefined();
    expect(typeof env.live!.feed.subscribe).toBe('function');
  });
});
