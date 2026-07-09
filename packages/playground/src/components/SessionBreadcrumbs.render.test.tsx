/**
 * Same idiom as `AutosaveStatus.render.test.tsx`: no DOM runner,
 * `renderToString` checks the markup contract for each state
 * directly off props (no store to fake).
 */
import { describe, test, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { SessionBreadcrumbs } from './SessionBreadcrumbs';

describe('SessionBreadcrumbs render states', () => {
  test('non-embed: root crumb is a real link to the app base, labeled Playground', () => {
    const html = renderToString(
      <SessionBreadcrumbs
        base="/"
        embedded={false}
        sessionTitle="Firestore rules for chat app"
        sessionId="sess-1"
      />,
    );
    expect(html).toContain('Playground');
    expect(html).toContain('<a href="/"');
    expect(html).toContain('Firestore rules for chat app');
  });

  test('embed=studio: root crumb still a real link, labeled Prototype and carrying the embed param', () => {
    const html = renderToString(
      <SessionBreadcrumbs
        base="/__pyric/playground/"
        embedded
        sessionTitle="My session"
        sessionId="sess-2"
      />,
    );
    expect(html).toContain('Prototype');
    expect(html).toContain('<a href="/__pyric/playground/?embed=studio"');
  });

  test('session crumb is non-navigating and marked as the current page', () => {
    const html = renderToString(
      <SessionBreadcrumbs base="/" embedded={false} sessionTitle="A session" sessionId="sess-3" />,
    );
    expect(html).toContain('aria-current="page"');
    // The current crumb renders as a <span>, not a second <a>.
    expect(html.match(/<a /g)?.length ?? 0).toBe(1);
  });

  test('falls back to a short id form before the session title has hydrated', () => {
    const html = renderToString(
      <SessionBreadcrumbs base="/" embedded={false} sessionTitle={null} sessionId="sess-abcdefgh" />,
    );
    expect(html).toContain('sess-abc…');
  });
});
