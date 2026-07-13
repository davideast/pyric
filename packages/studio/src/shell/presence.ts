/**
 * Connected-page presence for the Studio shell (#227).
 *
 * Pure view-model mapping (unit-tested) + a React hook that subscribes to the
 * live SharedWorker presence plane. The shell shows a quiet single-page chip
 * or a prominent multi-page chip; an accessible popover lists each client.
 */

import { useEffect, useState } from 'react';
import type { PresenceSnapshot } from '../clients/worker-live.js';
import { useEnvironment } from './environment.js';

/** Honest visibility boundary — presence only sees this SharedWorker. */
export const PRESENCE_BOUNDARY_COPY =
  'Only pages in this browser profile, on this origin, connected to this shared sandbox worker. Other profiles, incognito windows, origins, or worker names are not visible.';

export interface PresenceClientView {
  clientId: string;
  kindLabel: 'App' | 'Studio';
  route: string;
  visibilityLabel: 'Visible' | 'Hidden';
  /** True when this entry is the current Studio page. */
  isThisPage: boolean;
  /** Relative freshness hint from lastSeen vs `now`. */
  freshnessLabel: string;
}

export interface PresenceViewModel {
  /** Total logical pages attached to the worker. */
  count: number;
  /** Quiet single-page vs prominent multi-page chip label. */
  chipLabel: string;
  /** Whether the multi-page (prominent) chip style should be used. */
  prominent: boolean;
  clients: PresenceClientView[];
  boundaryCopy: string;
  /** How many OTHER pages must disconnect for a worker restart. */
  otherCount: number;
}

function freshnessLabel(lastSeen: number, now: number): string {
  const ageMs = Math.max(0, now - lastSeen);
  if (ageMs < 5_000) return 'just now';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

function kindLabel(kind: 'app' | 'studio'): 'App' | 'Studio' {
  return kind === 'studio' ? 'Studio' : 'App';
}

/**
 * Pure snapshot → shell view-model. `thisClientId` identifies the current
 * Studio page so its row can be labeled "This page".
 */
export function presenceViewModel(
  snapshot: PresenceSnapshot,
  thisClientId: string,
  now: number = Date.now(),
): PresenceViewModel {
  const count = snapshot.clients.length;
  const clients: PresenceClientView[] = snapshot.clients.map((c) => ({
    clientId: c.clientId,
    kindLabel: kindLabel(c.kind),
    route: c.route || '/',
    visibilityLabel: c.visibility === 'hidden' ? 'Hidden' : 'Visible',
    isThisPage: c.clientId === thisClientId,
    freshnessLabel: freshnessLabel(c.lastSeen, now),
  }));
  // This page first, then Studio before app, then route.
  clients.sort((a, b) => {
    if (a.isThisPage !== b.isThisPage) return a.isThisPage ? -1 : 1;
    if (a.kindLabel !== b.kindLabel) return a.kindLabel === 'Studio' ? -1 : 1;
    return a.route.localeCompare(b.route);
  });
  const otherCount = clients.filter((c) => !c.isThisPage).length;
  return {
    count,
    chipLabel: count === 1 ? '1 page connected' : `${count} pages connected`,
    prominent: count > 1,
    clients,
    boundaryCopy: PRESENCE_BOUNDARY_COPY,
    otherCount,
  };
}

/**
 * Subscribe to worker presence while the live plane is available. Returns
 * `null` until the first snapshot (or when there is no live plane).
 */
export function usePresenceView(): PresenceViewModel | null {
  const env = useEnvironment();
  const live =
    env.status === 'ready' && env.env.live ? env.env.live : null;
  const [view, setView] = useState<PresenceViewModel | null>(null);

  useEffect(() => {
    if (!live) {
      setView(null);
      return;
    }
    const thisId = live.presenceClientId;
    return live.subscribePresence((snap) => {
      setView(presenceViewModel(snap, thisId));
    });
  }, [live]);

  return view;
}
