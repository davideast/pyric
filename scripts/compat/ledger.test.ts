import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allCompatibilityRows, observationExceptions, surfaceDescriptors, surfaceRegistries, type CompatibilityRow } from './registry/index.ts';
import { renderAllCompatibilityMarkdown } from './generate-docs.ts';
import { loadObservations, REPO_ROOT } from './ledger.ts';
import { validateCompatibilityRegistry } from './validate-registry.ts';

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
});
