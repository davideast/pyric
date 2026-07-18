/**
 * `useActionDigest`: subscribe to an {@link EventFeed} and project it through
 * the pure reducer into a live {@link DigestItem}[] (Wave 2, F1).
 *
 * Buffers the feed into a bounded ring (so a long session can't grow unbounded),
 * then re-folds with `digestFromEvents` whenever the buffer changes. The fold is
 * cheap (the buffer is bounded and the digest is small), and keeping the buffer
 * as the source of truth, rather than an incremental accumulator in state,
 * keeps the hook trivially correct across feed swaps and Strict-Mode double
 * effects.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SandboxEvent } from 'pyric/sandbox';
import type { EventFeed } from './feed.js';
import { isSessionResetBoundary } from '../../events/fold.js';
import { digestFromEvents, type DigestItem } from './reducer.js';

export interface UseActionDigestOptions {
  /** Ring-buffer cap on raw events. Default 5000 (matches the traffic monitor). */
  bufferSize?: number;
}

export interface UseActionDigestResult {
  /** The aggregated digest, newest-activity first. */
  digest: DigestItem[];
  /** Raw events currently buffered (count only surfaced for the header). */
  eventCount: number;
}

export function useActionDigest(
  feed: EventFeed,
  { bufferSize = 5000 }: UseActionDigestOptions = {},
): UseActionDigestResult {
  const [events, setEvents] = useState<readonly SandboxEvent[]>([]);
  const bufferSizeRef = useRef(bufferSize);
  bufferSizeRef.current = bufferSize;

  useEffect(() => {
    // Seed from history (covers a late subscriber), then live-append.
    const initial = feed.history();
    setEvents(
      initial.length > bufferSizeRef.current
        ? initial.slice(initial.length - bufferSizeRef.current)
        : initial.slice(),
    );

    const unsubscribe = feed.subscribe((event) => {
      setEvents((prev) => {
        // A reset session_boundary wipes the buffer down to the boundary
        // itself (see `events/fold.ts`): the digest must not keep summarizing
        // a session the sandbox just erased (issue #359 extension).
        if (isSessionResetBoundary(event)) return [event];
        const next =
          prev.length >= bufferSizeRef.current ? prev.slice(1) : prev.slice();
        next.push(event);
        return next;
      });
    });
    return unsubscribe;
  }, [feed]);

  const digest = useMemo(() => digestFromEvents(events), [events]);

  return { digest, eventCount: events.length };
}
