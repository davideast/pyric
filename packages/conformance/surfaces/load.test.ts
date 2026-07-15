import { describe, expect, it } from 'bun:test';
import {
  loadCensusPairs,
  loadSurfaceDispositions,
  surfaceContracts,
  surfaceDescriptors,
  surfaceRecordProblems,
} from './load.ts';
import { SURFACE_CONTRACT_SCHEMA } from './types.ts';

describe('machine-readable surface contracts', () => {
  it('loads every authored contract through one schema-validated seam', () => {
    expect(surfaceContracts).toHaveLength(14);
    expect(surfaceDescriptors).toHaveLength(13);
    expect(loadCensusPairs()).toHaveLength(8);
    expect(loadSurfaceDispositions()).toHaveLength(51);
  });

  it('models the service-worker census-only surface as a contract, not code', () => {
    const contract = surfaceContracts.find(({ key }) => key === 'messaging-sw');
    expect(contract?.record).toMatchObject({
      schema: SURFACE_CONTRACT_SCHEMA,
      kind: 'census-only',
      censusSurface: 'messaging-sw',
      upstream: 'firebase/messaging/sw',
    });
    expect(surfaceDescriptors.some(({ surface }) => surface === 'messaging-sw')).toBe(false);
  });

  it('rejects executable-shape drift and unknown fields at the contract seam', () => {
    const problems = surfaceRecordProblems('bad.json', {
      schema: SURFACE_CONTRACT_SCHEMA,
      kind: 'native',
      order: 1,
      registry: 'rules',
      symbolSource: 'pyric/rules',
      observationPrefixes: ['rules-'],
      coverage: true,
      scopeNote: 'test',
      captureRigs: [],
      status: 'supported',
    });
    expect(problems.some((problem) => problem.includes('status'))).toBe(true);
  });

  it('keeps every disposition grouped with its owning census contract', () => {
    const auth = surfaceContracts.find(({ key }) => key === 'auth')?.record;
    expect(auth?.kind).toBe('mirror');
    if (auth?.kind !== 'mirror') throw new Error('expected Auth mirror contract');
    expect(auth.dispositions.flatMap(({ symbols }) => symbols)).toContain('multiFactor');
    expect(loadSurfaceDispositions().find(({ surface, symbol }) => surface === 'auth' && symbol === 'multiFactor'))
      .toMatchObject({ tier: 'deferred' });
  });
});
