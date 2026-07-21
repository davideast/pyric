import { describe, expect, test } from 'bun:test';
import { SITE_TABS, studioStaticPaths } from '../../src/lib/site-routes';

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
});
