import { beforeAll, describe, expect, test } from 'bun:test';
import { allCompatibilityRows } from '../../registry/index.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import { observationExceptions } from '../../exceptions/load.ts';
import { buildCompatibilityLedger, evidenceTierGapRows, loadObservations } from '../../src/ledger.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { assuranceNodeCountProblems } from '../../src/assurance-node-counts.ts';
import { canIUse, deriveConformanceModel, type ConformanceModel } from '../../src/conformance-model.ts';
import { resolveImportEvidence } from '../../src/can-i-use-query.ts';

let model: ConformanceModel;
beforeAll(async () => {
  model = await deriveConformanceModel();
}, 60_000);

describe('admin SDK surfaces: auth-admin, firestore-admin, rtdb-admin', () => {
  test('registers registry-only surface contracts routing pyric-admin imports cleanly', () => {
    const expected = [
      { surface: 'auth-admin', importPath: 'pyric-admin/auth', registryKey: 'auth', slug: 'auth-compat' },
      { surface: 'firestore-admin', importPath: 'pyric-admin/firestore', registryKey: 'firestore', slug: 'firestore-compat' },
      { surface: 'rtdb-admin', importPath: 'pyric-admin/database', registryKey: 'rtdb', slug: 'database-compat' },
    ] as const;

    for (const item of expected) {
      const descriptor = surfaceDescriptors.find((d) => d.surface === item.surface);
      expect(descriptor, `missing descriptor ${item.surface}`).toBeDefined();
      if (!descriptor || descriptor.kind !== 'registry-only') {
        throw new Error(`expected registry-only descriptor for ${item.surface}`);
      }
      expect(descriptor.coverage).toBe(false);
      expect(descriptor.climb).toBe(true);
      expect(descriptor.registryKey).toBe(item.registryKey);
      expect(descriptor.evidenceImports).toEqual([item.importPath]);

      const importEv = resolveImportEvidence(model.importEvidence, item.importPath);
      expect(importEv).toEqual({
        importPath: item.importPath,
        surface: item.surface,
        evidenceSlug: item.slug,
      });
    }
  });

  test('publishes honest capture-proven, self-tested, diverged, and unsupported admin rows', () => {
    const ledger = buildCompatibilityLedger(model);
    for (const surface of ['auth-admin', 'firestore-admin', 'rtdb-admin'] as const) {
      const entries = ledger.entries.filter((e) => e.surface === surface);
      expect(entries.length, `${surface} should have thorough rows`).toBeGreaterThanOrEqual(8);
      expect(entries.some((e) => e.status === 'unsupported')).toBe(true);

      for (const entry of entries) {
        if (entry.isCaptureProven) {
          expect(entry.oracleObservations.length).toBeGreaterThan(0);
        }
        if (entry.automation === 'unit-backed' && entry.status === 'conforms' && entry.oracleObservations.length === 0) {
          expect(entry.isCaptureProven).toBe(false);
          expect(entry.isSelfTestedOnly).toBe(true);
          expect(entry.conformanceTests.length).toBeGreaterThan(0);
        }
      }
    }

    // Unit-backed admin rows must never introduce new audit-gate evidence-tier gaps.
    const adminGaps = evidenceTierGapRows(ledger).filter((e) =>
      ['auth-admin', 'firestore-admin', 'rtdb-admin'].includes(e.surface),
    );
    expect(adminGaps).toEqual([]);

    // Honest divergence and unmodeled-API classifications on admin rows:
    const byId = new Map(ledger.entries.map((e) => [e.id, e]));
    expect(byId.get('auth-admin#1a')?.status).toBe('conforms');
    expect(byId.get('auth-admin#8')?.status).toBe('diverged-documented');
    expect(byId.get('auth-admin#14')?.status).toBe('diverged-documented');
    expect(byId.get('firestore-admin#4')?.status).toBe('diverged-documented');
    expect(byId.get('firestore-admin#8')?.status).toBe('diverged-documented');
    expect(byId.get('firestore-admin#10')?.status).toBe('unsupported');
    expect(byId.get('firestore-admin#11')?.status).toBe('unsupported');
    expect(byId.get('rtdb-admin#5')?.status).toBe('conforms');
    expect(byId.get('rtdb-admin#7')?.status).toBe('conforms');
    expect(byId.get('rtdb-admin#9')?.status).toBe('conforms');
    expect(byId.get('rtdb-admin#10')?.status).toBe('conforms');
  });

  test('supports scoped pyric-admin canIUse queries without colliding with bare rules/rtdb queries', () => {
    expect(canIUse(model, 'getAuth', { importPath: 'pyric-admin/auth' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({ surface: 'auth-admin', availability: 'available' })],
    });
    expect(canIUse(model, 'getFirestore', { importPath: 'pyric-admin/firestore' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({ surface: 'firestore-admin', availability: 'available' })],
    });
    expect(canIUse(model, 'getDatabase', { importPath: 'pyric-admin/database' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({ surface: 'rtdb-admin', availability: 'available' })],
    });

    expect(canIUse(model, 'onDisconnect').match).toBe('exact');
    expect(canIUse(model, 'getAfter').match).toBe('exact');
  });

  test('passes registry validation and per-service assurance node count invariants', () => {
    const problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: loadObservations(),
      observationExceptions,
    });
    expect(problems).toEqual([]);
    expect(assuranceNodeCountProblems(Object.keys(model.assuranceNodeVerdicts))).toEqual([]);
  });
});
