import { describe, expect, test } from 'bun:test';
import { readProbeSelectors, readSingleProbeSelector } from '../../src/probe-cli-args.ts';
import { selectAdminAppProbes } from '../../src/admin-app-probes.ts';
import { selectAdminFirestoreProbeId } from '../../src/admin-firestore-probes.ts';
import { selectAppRegistryProbes } from '../../src/app-registry-probes.ts';
import {
  captureClientStorageObservation,
  selectClientStorageProbeId,
} from '../../src/client-storage-probes.ts';
import { selectStorageAdminProbeId } from '../../src/storage-admin-probes.ts';
import type { Probe } from '../../rigs/types.ts';

describe('probe CLI selector support', () => {
  test('readProbeSelectors and readSingleProbeSelector parse --probe <id>, --probe=<id>, and custom inline prefixes', () => {
    expect(readProbeSelectors(['--write'])).toEqual([]);
    expect(readProbeSelectors(['--probe', 'a', '--probe=b'])).toEqual(['a', 'b']);
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

  test('selectAdminAppProbes, selectAppRegistryProbes, selectAdminFirestoreProbeId, and selectStorageAdminProbeId filter by --probe', () => {
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

    expect(selectAdminFirestoreProbeId(['--write'])).toBe('admin-firestore-document-snapshot-get');
    expect(
      selectAdminFirestoreProbeId(['--probe', 'admin-firestore-document-snapshot-get']),
    ).toBe('admin-firestore-document-snapshot-get');
    expect(() => selectAdminFirestoreProbeId(['--probe', 'other'])).toThrow(
      /unknown admin-firestore probe: other/,
    );

    expect(selectStorageAdminProbeId(['--write'])).toBe('admin-storage-metadata-download-url');
    expect(selectStorageAdminProbeId(['--probe', 'admin-storage-metadata-download-url'])).toBe(
      'admin-storage-metadata-download-url',
    );
    expect(() => selectStorageAdminProbeId(['--probe', 'other'])).toThrow(
      /unknown storage-admin probe: other/,
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
