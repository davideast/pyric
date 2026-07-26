import { beforeAll, describe, expect, it } from 'bun:test';
import { loadCensusPairs } from '../../surfaces/load.ts';
import { buildSurfaceCensus, censusForPair, runtimeExportNames, type SurfaceCensus } from '../../src/surface-census.ts';

let census: SurfaceCensus[];

beforeAll(async () => {
  census = await buildSurfaceCensus();
}, 60_000);

describe('Firebase public-surface census', () => {
  const expectedCounts = {
    ai: { runtime: [55, 38, 0], types: [164, 109] },
    app: { runtime: [10, 9, 13], types: [6, 4] },
    auth: { runtime: [85, 85, 0], types: [64, 64] },
    firestore: { runtime: [104, 104, 15], types: [78, 78] },
    database: { runtime: [44, 44, 10], types: [15, 15] },
    storage: { runtime: [18, 14, 9], types: [17, 13] },
    messaging: { runtime: [5, 5, 0], types: [8, 8] },
    'messaging-sw': { runtime: [4, 4, 0], types: [8, 8] },
  } as const;

  it('pins public runtime and type denominators for every mirrored Firebase entry point', () => {
    expect(census.map(({ surface }) => surface).sort()).toEqual(Object.keys(expectedCounts).sort());

    for (const surface of census) {
      const expected = expectedCounts[surface.surface as keyof typeof expectedCounts];
      expect(
        [surface.runtime.upstreamCount, surface.runtime.mapped.length, surface.runtime.privateUpstream.length],
        `${surface.surface} runtime public/mapped/private`,
      ).toEqual([...expected.runtime]);
      expect(
        [surface.types.upstreamCount, surface.types.mapped.length],
        `${surface.surface} types public/mapped`,
      ).toEqual([...expected.types]);
    }
  });

  it('partitions every upstream namespace without losing or inventing coverage credit', () => {
    for (const surface of census) {
      expect(
        surface.runtime.mapped.length + surface.runtime.dispositioned.length + surface.runtime.unmapped.length,
        `${surface.surface} public runtime partition`,
      ).toBe(surface.runtime.upstreamCount);
      expect(
        surface.types.mapped.length + surface.types.unmapped.length,
        `${surface.surface} public type partition`,
      ).toBe(surface.types.upstreamCount);
      expect(
        surface.runtime.upstreamCount + surface.runtime.privateUpstream.length,
        `${surface.surface} raw runtime reconciliation`,
      ).toBe(surface.rawRuntime.upstreamCount);
      expect(surface.runtime.privateUpstream.every((name) => name.startsWith('_'))).toBe(true);
      expect(surface.runtime.mapped.some((name) => surface.runtime.extra.includes(name))).toBe(false);
      expect(surface.types.mapped.some((name) => surface.types.extra.includes(name))).toBe(false);
    }
  });

  it('measures firebase/app as 9 of 10 public runtime exports', async () => {
    const app = census.find((surface) => surface.surface === 'app');
    expect(app).toBeDefined();
    expect(app!.runtime.upstreamCount).toBe(10);
    expect(app!.runtime.mapped).toHaveLength(9);
    expect(app!.runtime.dispositioned.map(({ symbol }) => symbol)).toEqual(['initializeServerApp']);
    expect(app!.runtime.unmapped).toEqual([]);
  });

  it('keeps Firebase private plumbing out of App public coverage', async () => {
    const app = census.find((surface) => surface.surface === 'app')!;
    expect(app.runtime.privateUpstream).toContain('_apps');
    expect(app.runtime.privateUpstream).toContain('_serverApps');
    expect(app.runtime.privateUpstream.every((name) => name.startsWith('_'))).toBe(true);
    expect(app.runtime.upstreamCount + app.runtime.privateUpstream.length).toBe(app.rawRuntime.upstreamCount);
  });

  it('fails closed on a new underscore export until its exact private classification is reviewed', async () => {
    const pair = loadCensusPairs().find(({ surface }) => surface === 'app')!;
    const result = await censusForPair(pair, async (specifier) =>
      specifier === pair.upstream
        ? [...pair.privateRuntimeExports, '_newInternalExport']
        : ['_newInternalExport']);
    expect(result.runtime.privateUpstream).toEqual(pair.privateRuntimeExports.slice().sort());
    expect(result.runtime.mapped).not.toContain('_newInternalExport');
    expect(result.runtime.unmapped).toContain('_newInternalExport');
  });

  it('tracks the public App type surface independently', async () => {
    const app = census.find((surface) => surface.surface === 'app')!;
    expect(app.types.upstreamCount).toBe(6);
    expect(app.types.mapped).toHaveLength(4);
    expect(app.types.unmapped).toEqual(['FirebaseServerApp', 'FirebaseServerAppSettings']);
  });

  it('never credits pyric-only exports toward Firebase coverage', async () => {
    const firestore = census.find((surface) => surface.surface === 'firestore')!;
    expect(firestore.runtime.extra.length).toBeGreaterThan(0);
    expect(firestore.runtime.mapped.some((name) => firestore.runtime.extra.includes(name))).toBe(false);
    expect(firestore.types.mapped.some((name) => firestore.types.extra.includes(name))).toBe(false);
  });
});

describe('deterministic workspace runtime export census', () => {
  it('uses workspace source even when stale built output can be imported', async () => {
    const names = await runtimeExportNames(
      'pyric/app',
      async () => ({ staleBuiltExport: true }),
    );
    expect(names).toContain('initializeApp');
    expect(names).not.toContain('staleBuiltExport');
  });

  it('propagates import failures for external packages', async () => {
    const failure = new Error('broken external entry');
    await expect(runtimeExportNames(
      'external-package',
      async () => { throw failure; },
    )).rejects.toBe(failure);
  });
});
