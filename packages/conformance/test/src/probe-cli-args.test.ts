import { describe, expect, test } from 'bun:test';
import { readSingleProbeSelector } from '../../src/probe-cli-args.ts';
import { selectAdminAppProbes } from '../../src/admin-app-probes.ts';
import { selectAppRegistryProbes } from '../../src/app-registry-probes.ts';
import {
  captureClientStorageObservation,
  selectClientStorageProbeId,
} from '../../src/client-storage-probes.ts';
import type { Probe } from '../../rigs/types.ts';

describe('probe CLI selector support', () => {
  test('readSingleProbeSelector parses --probe <id>, --probe=<id>, and custom inline prefixes', () => {
    expect(readSingleProbeSelector(['--write'])).toBeUndefined();
    expect(readSingleProbeSelector(['--write', '--probe', 'admin-app-get-apps'])).toBe(
      'admin-app-get-apps',
    );
    expect(readSingleProbeSelector(['--probe=app-registry-sdk-version'])).toBe(
      'app-registry-sdk-version',
    );
    expect(
      readSingleProbeSelector(['--write', '--only=app-registry-sdk-version'], ['--only=']),
    ).toBe('app-registry-sdk-version');
  });

  test('readSingleProbeSelector rejects missing or duplicate selectors', () => {
    expect(() => readSingleProbeSelector(['--probe'])).toThrow(/--probe requires/);
    expect(() => readSingleProbeSelector(['--probe', '--write'])).toThrow(/--probe requires/);
    expect(() => readSingleProbeSelector(['--probe='])).toThrow(/--probe= requires/);
    expect(() => readSingleProbeSelector(['--probe', 'a', '--probe', 'b'])).toThrow(
      /only one --probe selector is allowed/,
    );
  });

  test('selectAdminAppProbes and selectAppRegistryProbes filter by --probe and reject unknown ids', () => {
    const adminProbes = [{ id: 'admin-app-a' }, { id: 'admin-app-b' }];
    expect(selectAdminAppProbes(adminProbes, ['--write'])).toEqual(adminProbes);
    expect(selectAdminAppProbes(adminProbes, ['--probe', 'admin-app-b'])).toEqual([
      { id: 'admin-app-b' },
    ]);
    expect(() => selectAdminAppProbes(adminProbes, ['--probe', 'unknown'])).toThrow(
      /unknown admin-app probe: unknown/,
    );

    const appProbes = [{ id: 'app-registry-a' }, { id: 'app-registry-b' }];
    expect(selectAppRegistryProbes(appProbes, ['--only=app-registry-a'])).toEqual([
      { id: 'app-registry-a' },
    ]);
    expect(selectAppRegistryProbes(appProbes, ['--probe', 'app-registry-b'])).toEqual([
      { id: 'app-registry-b' },
    ]);
    expect(() => selectAppRegistryProbes(appProbes, ['--probe', 'unknown'])).toThrow(
      /unknown app-registry probe: unknown/,
    );
  });

  test('client-storage probe runner validates --probe and captures JSON-clean behavior', async () => {
    expect(selectClientStorageProbeId(['--write'])).toBe('client-storage-ref-urls');
    expect(selectClientStorageProbeId(['--probe', 'client-storage-ref-urls'])).toBe(
      'client-storage-ref-urls',
    );
    expect(() => selectClientStorageProbeId(['--probe', 'other-probe'])).toThrow(
      /unknown client-storage probe: other-probe/,
    );

    const sampleProbe: Probe = {
      description: 'sample client-storage probe',
      matrixRow: 'storage.ts :: ref(storage, url)',
      rowIds: ['storage#1'],
      observe: async () => ({ ok: true, omitted: undefined }),
    };
    const envelope = await captureClientStorageObservation(sampleProbe, '12.19.0');
    expect(envelope.name).toBe('client-storage-ref-urls');
    expect(envelope.fbSdkVersion).toBe('12.19.0');
    expect(envelope.behavior).toEqual({ ok: true });
    expect('omitted' in envelope.behavior).toBe(false);
  });
});
