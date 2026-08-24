import {
  createStudioRoutes,
  STUDIO_HUB_SEGMENT,
  type RouteId,
  type StudioRoute,
} from '@pyric/studio/routes';

export type PrimaryTabId = 'site-home' | 'docs' | 'studio';

export interface SiteTab {
  id: PrimaryTabId;
  label: string;
  path: string;
}

/** One authored route model consumed by Astro and the React Studio workspace. */
export const PUBLISHED_STUDIO_ROUTES: readonly StudioRoute[] = createStudioRoutes();

function pathForStudioRoute(id: RouteId): string {
  return id === 'home' ? `/${STUDIO_HUB_SEGMENT}` : `/${id}`;
}

/** Public site chrome: Home (marketing) | Docs | Studio (hub). */
export const PRIMARY_TABS: readonly SiteTab[] = [
  { id: 'site-home', label: 'Home', path: '/' },
  { id: 'docs', label: 'Docs', path: '/docs' },
  { id: 'studio', label: 'Studio', path: pathForStudioRoute('home') },
];

/** Finite Astro routes only; sandbox locations remain client-owned URL state. */
export function studioStaticPaths(): Array<{ params: { studio: string } }> {
  return [
    { params: { studio: STUDIO_HUB_SEGMENT } },
    ...PUBLISHED_STUDIO_ROUTES
      .filter((route) => route.id !== 'home')
      .map((route) => ({ params: { studio: route.id } })),
  ];
}
