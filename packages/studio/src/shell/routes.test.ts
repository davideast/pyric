import { describe, expect, it } from 'bun:test';
import {
  ROUTES,
  ROUTE_IDS,
  createStudioRoutes,
  findRoute,
  type RouteId,
} from './routes.js';

/** The tab set + order per specs/shell.md (Rules omitted: no approved
 *  surface exists yet — left out rather than shipping a placeholder). */
const SHELL_ROUTES: readonly RouteId[] = [
  'home',
  'firestore',
  'auth',
  'rtdb',
  'storage',
  'traffic',
  'settings',
];

describe('Studio route registry', () => {
  it('is the ordered top-level tab contract (specs/shell.md)', () => {
    expect(ROUTE_IDS).toEqual(SHELL_ROUTES);
    expect(ROUTES.map((route) => route.label)).toEqual([
      'Studio',
      'Firestore',
      'Auth',
      'RTDB',
      'Storage',
      'Traffic',
      'Settings',
    ]);
  });

  it('keeps Assurance available to local development without publishing it', () => {
    expect(ROUTE_IDS).not.toContain('assurance');
    expect(createStudioRoutes({ assuranceEnabled: true }).map((route) => route.id)).toEqual([
      'home',
      'firestore',
      'auth',
      'rtdb',
      'storage',
      'traffic',
      'assurance',
      'settings',
    ]);
  });

  it('does not expose the standalone Playground as a Studio route', () => {
    expect(ROUTE_IDS).not.toContain('prototype' as RouteId);
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

  it('falls back deferred published routes to Home', () => {
    expect(findRoute('assurance').id).toBe('home');
    expect(findRoute('prototype').id).toBe('home');
  });
});
