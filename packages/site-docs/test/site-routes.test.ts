import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PUBLISHED_STUDIO_ROUTES,
  SITE_TABS,
  studioStaticPaths,
} from '../src/lib/site-routes';

describe('unified site route registry', () => {
  test('generates only the finite published Studio entry pages', () => {
    expect(studioStaticPaths()).toEqual([
      { params: { studio: 'firestore' } },
      { params: { studio: 'auth' } },
      { params: { studio: 'rtdb' } },
      { params: { studio: 'storage' } },
      { params: { studio: 'traffic' } },
      { params: { studio: 'settings' } },
    ]);
  });

  test('adds Docs to navigation without making it a Studio surface', () => {
    expect(SITE_TABS.map(({ id }) => id)).toEqual([
      'home',
      'firestore',
      'auth',
      'rtdb',
      'storage',
      'traffic',
      'settings',
      'docs',
    ]);
    expect(studioStaticPaths().some(({ params }) => params.studio === 'docs')).toBeFalse();
  });

  test('publishes the same finite registry for host fallback routing', async () => {
    const { GET } = await import('../src/pages/studio-routes.json');
    expect(await GET().json()).toEqual({
      routes: PUBLISHED_STUDIO_ROUTES.map(({ id }) => id),
    });
  });

  test('mounts the browser-only Studio module from Astro entry pages', () => {
    const layout = readFileSync(
      new URL('../src/layouts/StudioLayout.astro', import.meta.url),
      'utf8',
    );
    const home = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
    const entries = readFileSync(
      new URL('../src/pages/[studio].astro', import.meta.url),
      'utf8',
    );

    expect(layout).toContain('<StudioApp client:only="react" />');
    expect(layout).toContain("from '@pyric/studio/app'");
    expect(home).toContain('<StudioLayout />');
    expect(entries).toContain('studioStaticPaths()');
    expect(entries).toContain('<StudioLayout />');
  });
});
