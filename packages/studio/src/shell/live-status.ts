/**
 * Live mode in Studio's status bar: the project a live host names, read once
 * from its `/__pyric/health` report, and the running count of billed calls
 * from every client. The chip reads both the same way
 * (`pyric/sandbox/internal`'s `live-status`), so the two never disagree.
 * A sandbox host names no live project, and Studio shows neither.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  createBilledCallCounter,
  readLiveHostStatus,
  type BilledCallCount,
  type LiveHostStatus,
} from 'pyric/sandbox/internal';
import { useStudioEventFeed } from './studio-events.js';

async function probeLiveHost(fetchImpl: typeof fetch): Promise<LiveHostStatus | null> {
  try {
    const response = await fetchImpl('/__pyric/health');
    if (!response.ok) return null;
    return readLiveHostStatus(await response.json());
  } catch {
    return null;
  }
}

/** The live host's project, or null on a sandbox host or before the probe answers. */
export function useLiveHost(): LiveHostStatus | null {
  const [live, setLive] = useState<LiveHostStatus | null>(null);
  useEffect(() => {
    if (typeof fetch === 'undefined') return;
    let alive = true;
    void probeLiveHost(fetch).then((status) => {
      if (alive) setLive(status);
    });
    return () => {
      alive = false;
    };
  }, []);
  return live;
}

/** The running count of billed calls in Studio's event feed. Counts only on a live host. */
export function useBilledCallCount(enabled: boolean): BilledCallCount {
  const feed = useStudioEventFeed();
  const counter = useMemo(() => createBilledCallCounter(), [feed]);
  const [count, setCount] = useState<BilledCallCount>(() => counter.count());
  useEffect(() => {
    if (!enabled) return;
    const changed = counter.add(feed.history());
    if (changed) setCount(counter.count());
    return feed.subscribe((event) => {
      const added = counter.add([event]);
      if (added) setCount(counter.count());
    });
  }, [enabled, feed, counter]);
  return count;
}
