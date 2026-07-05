import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allCompatibilityRows, observationExceptions, surfaceRegistries, type CompatibilityRow } from './registry/index.ts';
import { renderAllCompatibilityMarkdown } from './generate-docs.ts';
import { loadObservations, parseObservationRowIds, REPO_ROOT } from './ledger.ts';
import { validateCompatibilityRegistry } from './validate-registry.ts';

describe('single-source compatibility registry', () => {
  test('contains explicit rows for all major surfaces', () => {
    expect(allCompatibilityRows.length).toBeGreaterThan(600);
    expect(allCompatibilityRows.some((e) => e.id === 'auth#21' && e.oracleObservations.includes('auth-createUser-operationType'))).toBe(true);
    expect(allCompatibilityRows.some((e) => e.surface === 'firestore')).toBe(true);
    expect(allCompatibilityRows.some((e) => e.surface === 'rtdb')).toBe(true);
    expect(allCompatibilityRows.some((e) => e.surface === 'rtdb-modular')).toBe(true);
    expect(allCompatibilityRows.some((e) => e.surface === 'storage')).toBe(true);
  });

  test('parses compound observation matrix rows', () => {
    expect(parseObservationRowIds('rtdb-modular #142/#146/#147')).toEqual([
      'rtdb-modular#142',
      'rtdb-modular#146',
      'rtdb-modular#147',
    ]);
  });

  test('keeps suffix row IDs explicit', () => {
    expect(allCompatibilityRows.some((row) => row.id === 'auth#15a')).toBe(true);
    expect(parseObservationRowIds('rtdb-modular #37a/#37b')).toEqual(['rtdb-modular#37a', 'rtdb-modular#37b']);
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

  test('surfaces orphan observations', () => {
    const observations = loadObservations();
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows.filter((row) => !row.oracleObservations.includes('auth-createUser-operationType')),
      surfaces: surfaceRegistries,
      observations,
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('auth-createUser-operationType.json'))).toBe(true);
  });

  test('surfaces stale or missing test references', () => {
    const row = allCompatibilityRows.find((entry) => entry.conformanceTests.length > 0)!;
    const broken: CompatibilityRow = { ...row, conformanceTests: ['packages/pyric/test/missing.test.ts'] };
    const problems = validateCompatibilityRegistry({
      rows: [broken, ...allCompatibilityRows.filter((entry) => entry.id !== row.id)],
      surfaces: surfaceRegistries,
      observations: loadObservations(),
      observationExceptions,
    });
    expect(problems.some((problem) => problem.includes('packages/pyric/test/missing.test.ts'))).toBe(true);
  });

  test('generated markdown covers every checked-in compat document', () => {
    const docs = renderAllCompatibilityMarkdown();
    expect(docs.size).toBe(4);
    expect(docs.get('packages/pyric/docs/auth/COMPAT.md')).toContain('Generated from scripts/compat/registry/*.ts');
  });
});
