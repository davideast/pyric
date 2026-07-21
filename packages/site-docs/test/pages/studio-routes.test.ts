import { describe, expect, test } from 'bun:test';
import { studioStaticPaths } from '../../src/lib/site-routes';

describe('Studio route manifest', () => {
  test('publishes generated Studio entries and leaves Home at the mount root', async () => {
    const { GET } = await import('../../src/pages/studio-routes.json');
    expect(await GET().json()).toEqual({
      routes: studioStaticPaths().map(({ params }) => params.studio),
    });
  });
});
