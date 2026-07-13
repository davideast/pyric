import { ROUTES, type RouteId } from './routes.js';

export type UiArea = 'firestore' | 'auth' | 'storage' | 'traffic' | null;

export interface StudioTab {
  id: RouteId;
  label: string;
  group: 'Studio';
  area: UiArea;
  blurb: string;
}

const AREA_BY_ROUTE: Record<RouteId, UiArea> = {
  home: null,
  firestore: 'firestore',
  auth: 'auth',
  storage: 'storage',
  rtdb: null,
  traffic: 'traffic',
  assurance: null,
  settings: null,
};

export const TABS: readonly StudioTab[] = ROUTES.map((route) => ({
  id: route.id,
  label: route.label,
  group: 'Studio',
  area: AREA_BY_ROUTE[route.id],
  blurb: route.description,
}));

export const TAB_IDS: readonly RouteId[] = TABS.map((t) => t.id);

export const TAB_GROUPS: ReadonlyArray<{
  group: StudioTab['group'];
  tabs: readonly StudioTab[];
}> = [{ group: 'Studio', tabs: TABS }];

export function findTab(id: string): StudioTab {
  return TABS.find((t) => t.id === id) ?? TABS[0];
}
