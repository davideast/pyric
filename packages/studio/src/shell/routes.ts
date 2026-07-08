/**
 * Pyric Studio V1 routes. This is the single route registry used by the shell,
 * Home navigation, and tests, so top-level scope cannot drift across files.
 */

export type RouteId =
  | 'home'
  | 'firestore'
  | 'auth'
  | 'storage'
  | 'rtdb'
  | 'traffic'
  | 'playground'
  | 'settings';

export interface StudioRoute {
  id: RouteId;
  label: string;
  description: string;
  status?: 'coming-soon';
}

export const ROUTES: readonly StudioRoute[] = [
  {
    id: 'home',
    label: 'Home',
    description: 'Start from the surface that matches the task in front of you.',
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
    id: 'storage',
    label: 'Storage',
    description: 'Browse buckets, inspect objects, upload, and delete files.',
  },
  {
    id: 'rtdb',
    label: 'RTDB',
    description: 'Browse and edit RTDB data in the shared sandbox.',
  },
  {
    id: 'traffic',
    label: 'Traffic',
    description: 'Watch sandbox requests, listener activity, and rule decisions.',
  },
  {
    id: 'playground',
    label: 'Playground',
    description: 'Build and test with the full playground workspace.',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Configure models, keys, theme, sandbox maintenance, and diagnostics.',
  },
];

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((r) => r.id);

export function findRoute(id: string): StudioRoute {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0];
}
