/**
 * Tests for the Action Center event-feed seam (Wave 2, F1).
 *
 * The feed is the swappable source the reducer folds. These cover the empty
 * default, the sandbox-like adapter (the future-wiring seam), and the explicit
 * "not wired yet" worker stub.
 */

import { describe, expect, test } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  emptyEventFeed,
  feedFromSandboxLike,
  makeWorkerEventFeed,
} from './feed.js';

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

describe('emptyEventFeed', () => {
  test('has no history and a no-op subscription', () => {
    const feed = emptyEventFeed();
    expect(feed.history()).toEqual([]);
    const unsub = feed.subscribe(() => {
      throw new Error('should never fire');
    });
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

describe('feedFromSandboxLike', () => {
  test('proxies history() and onEvent() of a sandbox-like source', () => {
    const subs = new Set<(e: SandboxEvent) => void>();
    const events: SandboxEvent[] = [fakeWrite('a')];
    const source = {
      history: () => events,
      onEvent: (cb: (e: SandboxEvent) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };

    const feed = feedFromSandboxLike(source);
    expect(feed.history()).toBe(events);

    const seen: string[] = [];
    const unsub = feed.subscribe((e) => seen.push(e.id));
    expect(subs.size).toBe(1);
    for (const cb of subs) cb(fakeWrite('b'));
    expect(seen).toEqual(['b']);

    unsub();
    expect(subs.size).toBe(0);
  });
});

describe('makeWorkerEventFeed', () => {
  test('throws as superseded, pointing at env.live.feed', () => {
    expect(() => makeWorkerEventFeed()).toThrow(/superseded/i);
  });
});
