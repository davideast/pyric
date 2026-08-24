/**
 * Pyric Studio routes. This is the single route registry used by the shell,
 * Home navigation, and tests, so top-level scope cannot drift across files.
 *
 * Published surfaces: Studio hub, Firestore, Auth, RTDB, Storage, Traffic,
 * Settings. The hub's public path is `/studio` (`STUDIO_HUB_SEGMENT`); its
 * internal id stays `home`. The site chrome labels it Studio.
 * Assurance remains available in local Vite development while it is being
 * tested, but is intentionally omitted from published builds. The shell spec
 * also names Rules; no approved Rules surface
 * exists yet (the assist-era one was deliberately de-mounted, PRINCIPLES P4/M9),
 * so the tab is left out rather than shipping a placeholder.
 */

export type RouteId =
  | 'home'
  | 'firestore'
  | 'auth'
  | 'rtdb'
  | 'storage'
  | 'traffic'
  | 'assurance'
  | 'settings';

/** Public first-segment for the Studio hub. Internal `RouteId` remains `home`. */
export const STUDIO_HUB_SEGMENT = 'studio';

export interface StudioRoute {
  id: RouteId;
  label: string;
  description: string;
  status?: 'coming-soon';
}

const ROUTES_WITH_DEFERRED_SURFACES: readonly StudioRoute[] = [
  {
    id: 'home',
    label: 'Studio',
    description: 'What is happening in the sandbox, and where to go next.',
  },
  {
    id: 'firestore',
    label: 'Firestore',
    description: 'Browse and edit collections, documents, and references.',
  },
  {
    id: 'auth',
    label: 'Auth',
    description: 'View and edit users, claims, providers, and account state.',
  },
  {
    id: 'rtdb',
    label: 'RTDB',
    description: 'Browse and edit RTDB data in the shared sandbox.',
  },
  {
    id: 'storage',
    label: 'Storage',
    description: 'Browse buckets, inspect objects, upload, and delete files.',
  },
  {
    id: 'traffic',
    label: 'Traffic',
    description: 'Watch sandbox requests, listener activity, and rule decisions.',
  },
  {
    id: 'assurance',
    label: 'Assurance',
    description: 'Compare intended access with qualified local sandbox behavior.',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Configure models, keys, theme, sandbox maintenance, and diagnostics.',
  },
];

export function createStudioRoutes({
  assuranceEnabled = false,
}: {
  assuranceEnabled?: boolean;
} = {}): readonly StudioRoute[] {
  return ROUTES_WITH_DEFERRED_SURFACES.filter(
    (route) => route.id !== 'assurance' || assuranceEnabled,
  );
}

/** Vite dev is the private test surface; production builds publish core paths only. */
export const ROUTES = createStudioRoutes({ assuranceEnabled: import.meta.env?.DEV === true });

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((r) => r.id);

export function findRoute(id: string): StudioRoute {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0];
}
