import {
  createStudioRoutes,
  type RouteId,
  type StudioRoute,
} from '@pyric/studio/routes';

export interface SiteTab {
  id: RouteId | 'docs';
  label: string;
  path: string;
}

/** One authored route model consumed by Astro and the React Studio workspace. */
export const PUBLISHED_STUDIO_ROUTES: readonly StudioRoute[] = createStudioRoutes();

function pathForStudioRoute(id: RouteId): string {
  return id === 'home' ? '/' : `/${id}`;
}

export const SITE_TABS: readonly SiteTab[] = [
  ...PUBLISHED_STUDIO_ROUTES.map((route) => ({
    id: route.id,
    label: route.label,
    path: pathForStudioRoute(route.id),
  })),
  { id: 'docs', label: 'Docs', path: '/docs' },
];

/** Finite Astro routes only; sandbox locations remain client-owned URL state. */
export function studioStaticPaths(): Array<{ params: { studio: string } }> {
  return PUBLISHED_STUDIO_ROUTES
    .filter((route) => route.id !== 'home')
    .map((route) => ({ params: { studio: route.id } }));
}
