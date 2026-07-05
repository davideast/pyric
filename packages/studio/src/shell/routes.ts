/**
 * Studio surfaces + hash routes (Phase 0, F-SHELL).
 *
 * The C-parti shell routes between surfaces by `location.hash`
 * (`#session`, `#firestore`, `#auth`, `#storage`, `#traffic`). Phase 0 mounts a
 * labelled empty placeholder per route; Wave 2 fills each one with its feature
 * (composing `@pyric/ui`). Keeping the route table here (separate from the
 * shell component) lets later waves register their surface against a named
 * route without touching the shell layout.
 */

export type RouteId =
  | 'session'
  | 'firestore'
  | 'auth'
  | 'storage'
  | 'traffic'
  | 'rules'
  | 'review';

export interface StudioRoute {
  id: RouteId;
  /** Nav label. */
  label: string;
  /** One-line description shown in the placeholder until the surface lands. */
  blurb: string;
  /** The wave that fills this route (shown in the placeholder meta). */
  filledBy: string;
  /** Hidden from the tab row: a contextual route reached from a surface (e.g.
   *  Review, opened by a session action item), not a top-level destination. */
  hidden?: boolean;
}

export const ROUTES: readonly StudioRoute[] = [
  {
    id: 'session',
    label: 'Session',
    blurb:
      'The session view: a live activity grid over the unified event stream plus the action items (denials first) that invite a decision.',
    filledBy: 'Wave 2 · S-SESSION',
  },
  {
    id: 'firestore',
    label: 'Firestore',
    blurb:
      'Browse and edit Firestore collections and documents with the admin lens: miller columns, clickable cross-references, nested map / array / geopoint / timestamp / reference fields.',
    filledBy: 'Wave 2 · S-DATA',
  },
  {
    id: 'auth',
    label: 'Auth',
    blurb:
      'View, create, and edit sandbox users and their custom claims. Impersonate a user to reproduce a rules failure exactly as they hit it.',
    filledBy: 'Wave 2 · S-AUTH',
  },
  {
    id: 'storage',
    label: 'Storage',
    blurb:
      'Browse the object store, preview files inline, upload, and bulk-delete. gs:// references elsewhere in Studio link straight here.',
    filledBy: 'Wave 2 · S-STORAGE',
  },
  {
    id: 'traffic',
    label: 'Traffic',
    blurb:
      'Every request against the sandbox as it happens: reads, writes, listeners, and the rule decisions behind them, with a volume timeline.',
    filledBy: 'Wave 2 · S-TRAFFIC',
  },
  {
    id: 'rules',
    label: 'Rules',
    blurb:
      'Debug a denied request: the rule that denied it, the request.auth context, the simulator expression trace with real bound values, and one-click re-runs.',
    filledBy: 'Wave 2 · S-DEBUG',
  },
  {
    id: 'review',
    label: 'Review',
    blurb:
      'Review a staged change: the diff it would apply, and the gated Apply / Discard decision. Opened from a session action item, not a top-level tab.',
    filledBy: 'AI-as-flow · S-REVIEW',
    hidden: true,
  },
];

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((r) => r.id);

export function findRoute(id: string): StudioRoute {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0];
}
