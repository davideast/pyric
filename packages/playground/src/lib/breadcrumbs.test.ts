import { describe, expect, test } from 'bun:test';
import { buildPlaygroundBreadcrumbs, deriveSessionCrumbLabel } from './breadcrumbs';
import { playgroundRootCrumbLabel } from './studio-embed';

describe('deriveSessionCrumbLabel', () => {
  test('uses the trimmed session title when present', () => {
    expect(deriveSessionCrumbLabel('  Firestore rules for chat app  ', 'abc123')).toBe(
      'Firestore rules for chat app',
    );
  });

  test('falls back to a short id form when the title is missing', () => {
    expect(deriveSessionCrumbLabel(null, 'session-abcdefgh-1234')).toBe('session-…');
  });

  test('falls back to a short id form when the title is undefined', () => {
    expect(deriveSessionCrumbLabel(undefined, 'session-abcdefgh-1234')).toBe('session-…');
  });

  test('falls back to a short id form when the title is blank/whitespace', () => {
    expect(deriveSessionCrumbLabel('   ', 'session-abcdefgh-1234')).toBe('session-…');
  });

  test('returns a short id verbatim (no ellipsis) when already <= the short-id length', () => {
    expect(deriveSessionCrumbLabel('', 's1')).toBe('s1');
  });
});

describe('playgroundRootCrumbLabel', () => {
  test('reads "Playground" outside embed', () => {
    expect(playgroundRootCrumbLabel(false)).toBe('Playground');
  });

  test('reads "Prototype" inside the Studio embed', () => {
    expect(playgroundRootCrumbLabel(true)).toBe('Prototype');
  });
});

describe('buildPlaygroundBreadcrumbs', () => {
  test('root crumb navigates to the app base, session crumb is non-navigating', () => {
    const crumbs = buildPlaygroundBreadcrumbs({
      base: '/',
      embedded: false,
      sessionTitle: 'My rules session',
      sessionId: 'sess-1',
    });
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toEqual({ label: 'Playground', href: '/' });
    expect(crumbs[1]).toEqual({ label: 'My rules session', href: null });
  });

  test('root href carries the studio embed param and label when embedded', () => {
    const crumbs = buildPlaygroundBreadcrumbs({
      base: '/__pyric/playground/',
      embedded: true,
      sessionTitle: null,
      sessionId: 'sess-2-longer-id',
    });
    expect(crumbs[0]).toEqual({
      label: 'Prototype',
      href: '/__pyric/playground/?embed=studio',
    });
    // Session crumb falls back to short id form pre-hydration.
    expect(crumbs[1]).toEqual({ label: 'sess-2-l…', href: null });
  });

  test('root href respects a non-root base mount', () => {
    const crumbs = buildPlaygroundBreadcrumbs({
      base: '/app',
      embedded: false,
      sessionTitle: 'x',
      sessionId: 's',
    });
    expect(crumbs[0].href).toBe('/app/');
  });
});
