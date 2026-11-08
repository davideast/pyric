import { describe, expect, it } from 'bun:test';
import {
  parseResourcePattern,
  shouldFailOnDiagnostic,
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
  type DiagnosticRuntimeSite,
} from '../../../src/sandbox/internal/index.js';

function makeDiagnostic(
  overrides: Partial<AssuranceDiagnostic> & Pick<AssuranceDiagnostic, 'id'>,
): AssuranceDiagnostic {
  const base: AssuranceDiagnostic = {
    id: overrides.id,
    code: overrides.code ?? 'RULE_DENY',
    service: overrides.service ?? 'firestore',
    resourceId: overrides.resourceId ?? '(default)',
    severity: overrides.severity ?? 'medium',
    certainty: overrides.certainty ?? 'static-proof',
    message: overrides.message ?? 'Synthetic assurance diagnostic.',
  };
  return { ...base, ...overrides };
}

describe('AssuranceDiagnostic envelope sorting and gating policies', () => {
  it('sorts diagnostics deterministically across all tie-break axes without mutating input', () => {
    const resource = parseResourcePattern('storage', 'files/{uid}/{fileId}', 'alpha.appspot.com');
    const items: readonly AssuranceDiagnostic[] = [
      makeDiagnostic({
        id: 'd-low-prov',
        severity: 'low',
        certainty: 'proven-counterexample',
        witness: [{ uid: 'u1' }],
      }),
      makeDiagnostic({
        id: 'd-crit-heur',
        severity: 'critical',
        certainty: 'heuristic',
      }),
      makeDiagnostic({
        id: 'd-crit-prov-storage-beta',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'storage',
        resourceId: 'beta.appspot.com',
      }),
      makeDiagnostic({
        id: 'd-crit-prov-storage-alpha-b',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'storage',
        resourceId: 'alpha.appspot.com',
        resource,
        code: 'RULE_OPEN',
      }),
      makeDiagnostic({
        id: 'd-crit-prov-storage-alpha-a-src2',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'storage',
        resourceId: 'alpha.appspot.com',
        code: 'RULE_DENY',
        codeSite: { source: 'src/b.ts:20', through: 'src/client.ts:8' },
        ruleSite: { source: 'storage.rules:12', expression: 'request.auth != null' },
        remediation: 'Restrict read access to request.auth.uid == uid.',
      }),
      makeDiagnostic({
        id: 'd-crit-prov-storage-alpha-a-src1-id2',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'storage',
        resourceId: 'alpha.appspot.com',
        code: 'RULE_DENY',
        codeSite: { source: 'src/a.ts:10' },
      }),
      makeDiagnostic({
        id: 'd-crit-prov-storage-alpha-a-src1-id1',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'storage',
        resourceId: 'alpha.appspot.com',
        code: 'RULE_DENY',
        codeSite: { source: 'src/a.ts:10' },
      }),
      makeDiagnostic({
        id: 'd-crit-prov-firestore',
        severity: 'critical',
        certainty: 'proven-counterexample',
        service: 'firestore',
        resourceId: 'analytics-db',
      }),
      makeDiagnostic({
        id: 'd-crit-static',
        severity: 'critical',
        certainty: 'static-proof',
        service: 'rtdb',
        resourceId: 'primary-rtdb',
      }),
      makeDiagnostic({
        id: 'd-high-prov',
        severity: 'high',
        certainty: 'proven-counterexample',
      }),
      makeDiagnostic({
        id: 'd-med-static',
        severity: 'medium',
        certainty: 'static-proof',
      }),
    ];

    const snapshotBefore = items.map((d) => d.id);
    const sorted = sortAssuranceDiagnostics(items);

    expect(items.map((d) => d.id)).toEqual(snapshotBefore);
    expect(sorted.map((d) => d.id)).toEqual([
      'd-crit-prov-firestore',
      'd-crit-prov-storage-alpha-a-src1-id1',
      'd-crit-prov-storage-alpha-a-src1-id2',
      'd-crit-prov-storage-alpha-a-src2',
      'd-crit-prov-storage-alpha-b',
      'd-crit-prov-storage-beta',
      'd-crit-static',
      'd-crit-heur',
      'd-high-prov',
      'd-med-static',
      'd-low-prov',
    ]);
  });

  it('excludes heuristic diagnostics by default in shouldFailOnDiagnostic and honors minSeverity and includeHeuristic', () => {
    const critHeuristic = makeDiagnostic({
      id: 'h-crit',
      severity: 'critical',
      certainty: 'heuristic',
    });
    const lowStatic = makeDiagnostic({
      id: 's-low',
      severity: 'low',
      certainty: 'static-proof',
    });
    const medProven = makeDiagnostic({
      id: 'p-med',
      severity: 'medium',
      certainty: 'proven-counterexample',
    });
    const highStatic = makeDiagnostic({
      id: 's-high',
      severity: 'high',
      certainty: 'static-proof',
    });
    const critProven = makeDiagnostic({
      id: 'p-crit',
      severity: 'critical',
      certainty: 'proven-counterexample',
    });

    // Default policy: includeHeuristic is false, minSeverity is 'low'
    expect(shouldFailOnDiagnostic(critHeuristic)).toBe(false);
    expect(shouldFailOnDiagnostic(lowStatic)).toBe(true);
    expect(shouldFailOnDiagnostic(medProven)).toBe(true);
    expect(shouldFailOnDiagnostic(highStatic)).toBe(true);
    expect(shouldFailOnDiagnostic(critProven)).toBe(true);

    // minSeverity: 'high' with default includeHeuristic (false)
    expect(shouldFailOnDiagnostic(critHeuristic, { minSeverity: 'high' })).toBe(false);
    expect(shouldFailOnDiagnostic(lowStatic, { minSeverity: 'high' })).toBe(false);
    expect(shouldFailOnDiagnostic(medProven, { minSeverity: 'high' })).toBe(false);
    expect(shouldFailOnDiagnostic(highStatic, { minSeverity: 'high' })).toBe(true);
    expect(shouldFailOnDiagnostic(critProven, { minSeverity: 'high' })).toBe(true);

    // includeHeuristic: true with minSeverity: 'medium'
    const lowHeuristic = makeDiagnostic({
      id: 'h-low',
      severity: 'low',
      certainty: 'heuristic',
    });
    const medHeuristic = makeDiagnostic({
      id: 'h-med',
      severity: 'medium',
      certainty: 'heuristic',
    });
    expect(
      shouldFailOnDiagnostic(critHeuristic, { minSeverity: 'medium', includeHeuristic: true }),
    ).toBe(true);
    expect(
      shouldFailOnDiagnostic(medHeuristic, { minSeverity: 'medium', includeHeuristic: true }),
    ).toBe(true);
    expect(
      shouldFailOnDiagnostic(lowHeuristic, { minSeverity: 'medium', includeHeuristic: true }),
    ).toBe(false);
  });

  it('preserves runtimeSite evidence on AssuranceDiagnostic across sorting', () => {
    const runtimeSite: DiagnosticRuntimeSite = {
      source: 'snapshot:firestore:(default)',
      concretePath: 'orgs/acme/items/1',
    };
    const diag = makeDiagnostic({
      id: 'd-runtime',
      certainty: 'heuristic',
      runtimeSite,
    });
    const [sorted] = sortAssuranceDiagnostics([diag]);
    expect(sorted?.runtimeSite).toEqual({
      source: 'snapshot:firestore:(default)',
      concretePath: 'orgs/acme/items/1',
    });
  });
});
