import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allCompatibilityRows, observationExceptions, surfaceDescriptors, surfaceRegistries, type CompatibilityRow } from '../registry/index.ts';
import { renderAllCompatibilityMarkdown } from './generate-docs.ts';
import { loadObservations, REPO_ROOT } from './ledger.ts';
import { validateCompatibilityRegistry } from './validate-registry.ts';
import { loadRigManifests } from '../rigs/load.ts';
import type { RigManifest } from '../rigs/types.ts';

describe('single-source compatibility registry', () => {
  test('contains explicit rows for all major surfaces', () => {
    expect(allCompatibilityRows.length).toBeGreaterThan(600);
    expect(allCompatibilityRows.some((e) => e.id === 'auth#21' && e.oracleObservations.includes('auth-createUser-operationType'))).toBe(true);
    for (const descriptor of surfaceDescriptors) {
      expect(allCompatibilityRows.some((e) => e.surface === descriptor.surface)).toBe(true);
    }
  });

  test('uses typed statuses with display qualifiers split out', () => {
    const wrapped = allCompatibilityRows.find((row) => row.id === 'auth#4');
    expect(wrapped?.status).toBe('conforms');
    expect(wrapped?.statusNote).toBe('(wrap)');
    const diverged = allCompatibilityRows.find((row) => row.id === 'auth#7');
    expect(diverged?.status).toBe('diverged-documented');
  });

  test('observations carry structured compound row links', () => {
    const observations = loadObservations();
    const window = observations.find((obs) => obs.name === 'rtdb-modular-orderbychild-window');
    expect(window?.rowIds).toContain('rtdb-modular#142');
    expect(window?.rowIds).toContain('rtdb-modular#146');
    expect(window?.rowIds).toContain('rtdb-modular#147');
  });

  test('keeps suffix row IDs explicit', () => {
    expect(allCompatibilityRows.some((row) => row.id === 'auth#15a')).toBe(true);
    const observations = loadObservations();
    const abort = observations.find((obs) => obs.name === 'rtdb-modular-runtransaction-abort-undefined');
    expect(abort?.rowIds).toContain('rtdb-modular#M37a');
  });

  test('registers sandbox-only exceptions explicitly', () => {
    const row = allCompatibilityRows.find((entry) => entry.automation === 'sandbox-only');
    expect(row?.exceptionReason).toBeTruthy();
  });

  test('registers oracle-backed rows explicitly', () => {
    const row = allCompatibilityRows.find((entry) => entry.id === 'firestore#20');
    expect(row?.automation).toBe('oracle-backed');
    expect(row?.oracleObservations).toContain('firestore-read-denied-error-code');
  });

  test('registers unit-only rows with existing test paths', () => {
    const row = allCompatibilityRows.find((entry) => entry.automation === 'unit-backed' && entry.oracleObservations.length === 0);
    expect(row).toBeTruthy();
    for (const testPath of row?.conformanceTests ?? []) expect(existsSync(join(REPO_ROOT, testPath))).toBe(true);
  });

  test('validates the checked-in registry and observations cleanly', () => {
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
    });
    expect(problems).toEqual([]);
  });

  test('surfaces orphan observations', () => {
    const observations = loadObservations();
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows.filter((row) => !row.oracleObservations.includes('auth-createUser-operationType')),
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('auth-createUser-operationType.json'))).toBe(true);
  });

  test('surfaces observations that do not link their citing rows back', () => {
    const observations = loadObservations().map((obs) =>
      obs.name === 'auth-createUser-operationType' ? { ...obs, rowIds: obs.rowIds.filter((id) => id !== 'auth#21') } : obs,
    );
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('cited by auth#21 but rowIds does not list it'))).toBe(true);
  });

  test('surfaces observation rowIds that name unknown rows', () => {
    const observations = loadObservations().map((obs) =>
      obs.name === 'auth-createUser-operationType' ? { ...obs, rowIds: [...obs.rowIds, 'auth#9999'] } : obs,
    );
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes("rowIds entry 'auth#9999' does not match a registry row"))).toBe(true);
  });

  test('surfaces stale or missing test references', () => {
    const row = allCompatibilityRows.find((entry) => entry.conformanceTests.length > 0)!;
    const broken: CompatibilityRow = { ...row, conformanceTests: ['packages/pyric/test/missing.test.ts'] };
    const problems = validateCompatibilityRegistry({
      rows: [broken, ...allCompatibilityRows.filter((entry) => entry.id !== row.id)],
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('packages/pyric/test/missing.test.ts'))).toBe(true);
  });

  test('generated markdown covers every checked-in compat document', () => {
    const docs = renderAllCompatibilityMarkdown();
    expect(docs.size).toBe(surfaceRegistries.length);
    expect(docs.get('packages/pyric/docs/auth/COMPAT.md')).toContain('Generated from scripts/compat/registry/*.ts');
  });

  test('every observation internal name matches its filename minus .json', () => {
    const observations = loadObservations();
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('does not match filename'))).toBe(false);
  });

  test('surfaces an observation whose internal name has drifted from its filename', () => {
    const observations = loadObservations().map((obs) =>
      obs.name === 'auth-createUser-operationType' ? { ...obs, name: 'auth-createUser-operationType-drifted' } : obs,
    );
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes("internal name 'auth-createUser-operationType-drifted' does not match filename"))).toBe(true);
  });
});

describe('oracle rig manifests', () => {
  test('every checked-in rig manifest validates cleanly', async () => {
    const rigManifests = await loadRigManifests();
    expect(rigManifests.length).toBeGreaterThanOrEqual(4);
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests,
    });
    expect(problems).toEqual([]);
  });

  test('surfaces a rig manifest whose script is missing', async () => {
    const rigManifests = await loadRigManifests();
    const broken: RigManifest[] = rigManifests.map((m) =>
      m.id === 'admin-app' ? { ...m, script: 'scripts/oracle/does-not-exist.ts' } : m,
    );
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests: broken,
    });
    expect(problems.some((p) => p.includes("script 'scripts/oracle/does-not-exist.ts' is missing"))).toBe(true);
  });

  test('surfaces a rig manifest prefix the registry does not recognize', async () => {
    const rigManifests = await loadRigManifests();
    const broken: RigManifest[] = rigManifests.map((m) =>
      m.id === 'admin-app' ? { ...m, observationPrefixes: [...m.observationPrefixes, 'not-a-real-prefix-'] } : m,
    );
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests: broken,
    });
    expect(problems.some((p) => p.includes("observation prefix 'not-a-real-prefix-' is not a recognized surface descriptor prefix"))).toBe(true);
  });

  test('surfaces a rig manifest prefix with zero matching observations', async () => {
    const rigManifests = await loadRigManifests();
    // 'storage-' is a real, registry-recognized prefix, but declaring it on the
    // admin-app rig (which owns none of those files) proves the "prefix must
    // match at least one observation" check without inventing a fake prefix.
    const broken: RigManifest[] = rigManifests.map((m) =>
      m.id === 'admin-app' ? { ...m, observationPrefixes: ['this-prefix-matches-nothing-'] } : m,
    );
    // Recognize the synthetic prefix at the descriptor level too, isolating
    // this test to the "matches no observation file" check alone.
    const descriptorsWithSyntheticPrefix = [
      ...surfaceDescriptors,
      { ...surfaceDescriptors[0]!, observationPrefix: 'this-prefix-matches-nothing-' },
    ];
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: descriptorsWithSyntheticPrefix,
      observations: loadObservations(),
      observationExceptions,
      rigManifests: broken,
    });
    expect(problems.some((p) => p.includes("observation prefix 'this-prefix-matches-nothing-' matches no observation file"))).toBe(true);
  });

  test('surfaces an observation file matching no rig manifest prefix', async () => {
    const rigManifests = await loadRigManifests();
    // Narrow admin-app's manifest to a prefix that matches none of the real
    // admin-app-*.json files, so those files fall through with no owner.
    const narrowed: RigManifest[] = rigManifests.map((m) =>
      m.id === 'admin-app' ? { ...m, observationPrefixes: ['admin-app-nonexistent-'] } : m,
    );
    const descriptorsWithSyntheticPrefix = [
      ...surfaceDescriptors,
      { ...surfaceDescriptors[0]!, observationPrefix: 'admin-app-nonexistent-' },
    ];
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: descriptorsWithSyntheticPrefix,
      observations: loadObservations(),
      observationExceptions,
      rigManifests: narrowed,
    });
    expect(problems.some((p) => p.includes("admin-app-deleteapp.json: does not match any rig manifest's observation prefix"))).toBe(true);
  });

  test('surfaces an ambiguous longest-prefix match across two different rigs', async () => {
    const rigManifests = await loadRigManifests();
    // Fabricate a second rig manifest that also claims the 'admin-app-' prefix
    // real admin-app-*.json files use — two DIFFERENT rigs owning the same
    // prefix is exactly the ambiguity this check exists to catch.
    const impostor: RigManifest = {
      ...rigManifests.find((m) => m.id === 'admin-app')!,
      id: 'admin-app-impostor',
    };
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
      rigManifests: [...rigManifests, impostor],
    });
    expect(problems.some((p) => p.includes('ambiguous longest-prefix match across rigs'))).toBe(true);
  });
});
