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
import { studioSessionHeaders } from './serve-init.js';
import { useStudioEventFeed } from './studio-events.js';

async function readHealth(): Promise<LiveHostStatus | null> {
  const headers = studioSessionHeaders();
  const response = await fetch('/__pyric/health', {
    cache: 'no-store',
    ...(headers ? { headers } : {}),
  });
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

/** With no fetch there is no health report to wait for. */
const currentAnswered = (): boolean => typeof fetch === 'undefined' || (poller?.answered() ?? false);

/**
 * Whether the host's first health read has finished. Until it has,
 * {@link useLiveHost} is null on a live host too, so a view that subscribes
 * to the sandbox's data waits for this: on a live host that subscription
 * would reach the host as Studio's own call and join the session's events.
 * A read that fails counts as an answer, so a host with no health report
 * still shows its sandbox views.
 */
export function useHostAnswered(): boolean {
  return useSyncExternalStore(subscribe, currentAnswered, () => false);
}

/** Reads the host's status again soon after each event Studio's feed delivers: the count moves with traffic. */
export function useLiveStatusRefresh(enabled: boolean): void {
  const feed = useStudioEventFeed();
  useEffect(() => {
    if (!enabled) return;
    return feed.subscribe(() => poller?.refreshSoon());
  }, [enabled, feed]);
}

/** Disposes the module poller so tests can switch between sandbox and live hosts. */
export function resetLiveStatusPollerForTesting(): void {
  poller?.dispose();
  poller = undefined;
}
