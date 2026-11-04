/**
 * Live mode in Studio: the live host's status, read from its
 * `/__pyric/health` report through the shared poller the chip uses
 * (`pyric/sandbox/internal`), so Studio and the chip show one project line
 * and one billed count, the host's. One poller serves every Studio view;
 * it reads again while the host is live, sooner after traffic, and after a
 * failed read until one succeeds. A sandbox host has no live status, and
 * Studio shows none.
 */
import { useEffect, useSyncExternalStore } from 'react';
import {
  createLiveStatusPoller,
  readLiveHostStatus,
  type LiveHostStatus,
  type LiveStatusPoller,
} from 'pyric/sandbox/internal';
import { useStudioEventFeed } from './studio-events.js';

async function readHealth(): Promise<LiveHostStatus | null> {
  const response = await fetch('/__pyric/health', { cache: 'no-store' });
  if (!response.ok) throw new Error(`The host's health report answered ${response.status}.`);
  return readLiveHostStatus(await response.json());
}

const listeners = new Set<() => void>();
let poller: LiveStatusPoller | undefined;

function sharedPoller(): LiveStatusPoller {
  poller ??= createLiveStatusPoller(readHealth, () => {
    for (const listener of listeners) listener();
  });
  return poller;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const hasFetch = typeof fetch !== 'undefined';
  if (hasFetch) sharedPoller().start();
  return () => {
    listeners.delete(listener);
  };
}

const currentStatus = (): LiveHostStatus | null => poller?.current() ?? null;

/** The live host's status, or null on a sandbox host or before a read answers. */
export function useLiveHost(): LiveHostStatus | null {
  return useSyncExternalStore(subscribe, currentStatus, () => null);
}

/** Reads the host's status again soon after each event Studio's feed delivers: the count moves with traffic. */
export function useLiveStatusRefresh(enabled: boolean): void {
  const feed = useStudioEventFeed();
  useEffect(() => {
    if (!enabled) return;
    return feed.subscribe(() => poller?.refreshSoon());
  }, [enabled, feed]);
}
