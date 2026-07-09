/**
 * Action Center view (Wave 2, F1).
 *
 * Subscribes to the live {@link EventFeed} (via {@link useActionDigest}), folds
 * it through the pure reducer, and renders the digest: one line per
 * `service · target · op · actor` group, newest activity first, with a count
 * badge for collapsed bursts and an actor/lens attribution.
 *
 * Styling references the `@theme` token roles only (no raw hexes) so it tracks
 * the shell's theme. Empty states cover both "env not resolved yet" (T3 pending)
 * and "resolved but no activity", and, honestly, today the wired `local` feed
 * is empty because the worker doesn't surface the event stream over its port yet
 * (see `./feed.ts`), so the digest stays empty until that channel lands or a
 * real feed is injected.
 */

import { useMemo } from 'react';
import { useEnvironment } from '../../shell/environment.js';
import { emptyEventFeed, type EventFeed } from './feed.js';
import { useActionDigest } from './useActionDigest.js';
import {
  attribution,
  phraseDigest,
  type DigestItem,
} from './reducer.js';

/** Per-service accent role (token-driven). */
function serviceColor(service: DigestItem['service']): string {
  switch (service) {
    case 'firestore':
      return 'text-primary';
    case 'auth':
      return 'text-info';
    case 'storage':
      return 'text-warning';
    case 'rtdb':
      return 'text-soft-white';
    case 'messaging':
      return 'text-info';
  }
}

function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function DigestRow({ item, now }: { item: DigestItem; now: number }) {
  const attr = attribution(item);
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-sidebar-bg px-4 py-3">
      <span
        className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-current ${serviceColor(
          item.service,
        )}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm text-soft-white">
            {phraseDigest(item)}
          </p>
          <span className="shrink-0 text-xs tabular-nums text-slate-gray">
            {relativeTime(item.lastAt, now)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-gray">
          <span className="uppercase tracking-wide">{item.service}</span>
          {item.count > 1 ? (
            <span className="rounded-full bg-content-bg px-1.5 py-0.5 tabular-nums text-soft-white">
              ×{item.count}
            </span>
          ) : null}
          {attr ? <span className="text-info">· {attr}</span> : null}
          {item.samples.length > 1 ? (
            <span className="truncate font-mono text-slate-gray/80">
              {item.samples.slice(0, 3).join(', ')}
              {item.distinctTargets > 3
                ? ` +${item.distinctTargets - 3}`
                : ''}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export interface ActionCenterProps {
  /**
   * Override the event feed (tests / explicit injection). When omitted, the
   * Action Center uses the env's LIVE worker event feed in `local` mode (Wave
   * 2.5a): real cross-service activity from the shared SharedWorker sandbox,
   * falling back to {@link emptyEventFeed} when no live plane is present (SSR /
   * unsupported browser / HTTP-only fallback).
   */
  feed?: EventFeed;
}

export function ActionCenter({ feed }: ActionCenterProps) {
  const env = useEnvironment();
  const { status } = env;
  // Feed resolution (Wave 2.5a): an explicit `feed` prop wins (tests); else the
  // env's live worker feed when a SharedWorker plane is present; else an empty
  // feed (the honest fallback). The live feed is `{ history, subscribe }`-shaped
  // (structurally an `EventFeed`) so it folds through the reducer unchanged.
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  const activeFeed = useMemo(
    () => feed ?? liveFeed ?? emptyEventFeed(),
    [feed, liveFeed],
  );
  const { digest, eventCount } = useActionDigest(activeFeed);
  const now = Date.now();

  const backendLive = status === 'ready';

  if (digest.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center text-center">
        {!backendLive ? (
          <p className="mb-3 rounded-full border border-border px-3 py-1 text-xs uppercase tracking-wide text-slate-gray">
            Local backend pending
          </p>
        ) : null}
        <h2 className="text-base font-semibold text-soft-white">Action Center</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-gray">
          {backendLive
            ? 'No activity yet. As the app, an agent, or you change the backend (docs written, users signed in, objects uploaded) a digest of what changed shows up here, attributed to who did it.'
            : 'A live digest of what changed across every service mounts here once the local sandbox backend is reachable and emitting events.'}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-soft-white">
          Activity digest
        </h2>
        <span className="text-xs text-slate-gray">
          {digest.length} {digest.length === 1 ? 'group' : 'groups'} ·{' '}
          {eventCount} {eventCount === 1 ? 'event' : 'events'}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {digest.map((item) => (
          <DigestRow key={item.id} item={item} now={now} />
        ))}
      </ul>
    </div>
  );
}
