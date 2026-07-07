import { describe, expect, it } from 'bun:test';
import { ROUTES, ROUTE_IDS, findRoute, type RouteId } from './routes.js';

const V1_ROUTES: readonly RouteId[] = [
  'home',
  'firestore',
  'auth',
  'storage',
  'rtdb',
  'traffic',
  'playground',
  'settings',
];

describe('Studio V1 route registry', () => {
  it('is the ordered top-level tab contract', () => {
    expect(ROUTE_IDS).toEqual(V1_ROUTES);
    expect(ROUTES.map((route) => route.label)).toEqual([
      'Home',
      'Firestore',
      'Auth',
      'Storage',
      'Realtime DB',
      'Traffic',
      'Playground',
      'Settings',
    ]);
  });

  it('does not expose deferred V1 scope as top-level tabs', () => {
    expect(ROUTE_IDS).not.toContain('session' as RouteId);
    expect(ROUTE_IDS).not.toContain('rules' as RouteId);
    expect(ROUTE_IDS).not.toContain('review' as RouteId);
    expect(ROUTE_IDS).not.toContain('agent' as RouteId);
  });

  it('marks Realtime DB as the only coming-soon route', () => {
    expect(ROUTES.filter((route) => route.status === 'coming-soon').map((route) => route.id)).toEqual([
      'rtdb',
    ]);
  });

  it('falls back unknown routes to Home', () => {
    expect(findRoute('not-real').id).toBe('home');
  });
});
