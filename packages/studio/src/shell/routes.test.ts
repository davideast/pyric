import { describe, expect, it } from 'bun:test';
import { ROUTES, ROUTE_IDS, findRoute, type RouteId } from './routes.js';

/** The tab set + order per specs/shell.md (Rules omitted: no approved
 *  surface exists yet — left out rather than shipping a placeholder). */
const SHELL_ROUTES: readonly RouteId[] = [
  'home',
  'firestore',
  'auth',
  'rtdb',
  'storage',
  'traffic',
  'prototype',
  'settings',
];

describe('Studio route registry', () => {
  it('is the ordered top-level tab contract (specs/shell.md)', () => {
    expect(ROUTE_IDS).toEqual(SHELL_ROUTES);
    expect(ROUTES.map((route) => route.label)).toEqual([
      'Home',
      'Firestore',
      'Auth',
      'RTDB',
      'Storage',
      'Traffic',
      'Prototype',
      'Settings',
    ]);
  });

  it('renamed playground → prototype (no stale id survives)', () => {
    expect(ROUTE_IDS).not.toContain('playground' as RouteId);
  });

  it('does not expose deferred scope as top-level tabs', () => {
    expect(ROUTE_IDS).not.toContain('session' as RouteId);
    expect(ROUTE_IDS).not.toContain('rules' as RouteId);
    expect(ROUTE_IDS).not.toContain('review' as RouteId);
    expect(ROUTE_IDS).not.toContain('agent' as RouteId);
  });

  it('does not mark top-level routes as coming soon', () => {
    expect(ROUTES.filter((route) => route.status === 'coming-soon').map((route) => route.id)).toEqual([]);
  });

  it('falls back unknown routes to Home', () => {
    expect(findRoute('not-real').id).toBe('home');
  });
});
