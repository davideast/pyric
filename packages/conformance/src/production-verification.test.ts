/**
 * Tests for the ONE production-verification predicate.
 *
 * The negative cases carry the weight. `isProductionVerified` decides what goes
 * into the coverage report's trust number AND what lets an assurance capability
 * claim `supported` instead of abstaining, so a false positive here is a false
 * security claim downstream. Each way a construct can FAIL to be credited —
 * the row is not conforming, the row is not oracle-backed, the row is not on a
 * rules-engine surface, the row's scope omits the construct, nothing mentions it
 * at all — is driven separately.
 */
import { describe, expect, it } from 'bun:test';
import {
  RULES_ENGINE_SURFACES,
  describeProductionEvidence,
  indexConstructScopes,
  isProductionVerified,
  productionEvidenceFor,
} from './production-verification.ts';
import { surfaceRegistries } from '../registry/index.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from '../registry/types.ts';
import coverageReport from '../rules-language/coverage-report.json' with { type: 'json' };

function row(id: string, over: Partial<CompatibilityRow> = {}): CompatibilityRow {
  return {
    id,
    surface: 'rtdb-rules',
    aliases: [],
    rowRef: id,
    rowNumber: 1,
    section: 's',
    api: 'Rules simulator',
    behavior: 'b',
    status: 'conforms',
    evidence: 'e',
    risk: [],
    riskScore: 0,
    riskReasons: [],
    automation: 'oracle-backed',
    oracleObservations: [],
    conformanceTests: [],
    ...over,
  };
}

function registry(rows: CompatibilityRow[]): CompatibilitySurfaceRegistry {
  return {
    surface: 'rules',
    compatPath: 'x.md',
    blocks: [{ kind: 'table', prefix: '', rows }],
  } as CompatibilitySurfaceRegistry;
}

describe('isProductionVerified', () => {
  it('credits a construct SYNTACTICALLY: a captured scenario exercises it', () => {
    expect(isProductionVerified({ scenarios: ['r1-auth-only'], provingRows: [] })).toBe(true);
  });

  it('credits a construct BEHAVIORALLY: a conforming oracle-backed row scopes it', () => {
    expect(isProductionVerified({ scenarios: [], provingRows: ['rtdb-rules#5'] })).toBe(true);
  });

  it('does NOT credit a construct nothing backs', () => {
    expect(isProductionVerified({ scenarios: [], provingRows: [] })).toBe(false);
  });

  it('cites the syntactic path when both are present (a scenario is the stronger evidence)', () => {
    expect(describeProductionEvidence({ scenarios: ['a', 'b'], provingRows: ['x#1'] })).toBe(
      'production-verified by 2 captured scenario(s)',
    );
  });

  it('names the proving rows when only the behavioral path backs it', () => {
    expect(describeProductionEvidence({ scenarios: [], provingRows: ['x#1', 'x#2'] })).toBe(
      'production-verified by conforming oracle-backed rules-engine row x#1, x#2',
    );
  });

  it('says so plainly when nothing verifies it', () => {
    expect(describeProductionEvidence({ scenarios: [], provingRows: [] })).toBe(
      'no production-captured scenario and no conforming oracle-backed row verifies it',
    );
  });
});

describe('indexConstructScopes', () => {
  it('a conforming, oracle-backed rules-engine row PROVES the constructs in its scope', () => {
    const { provingRows, divergingRows } = indexConstructScopes([
      registry([row('rtdb-rules#5', { constructs: ['rtdb.semantic.read-cascade'] })]),
    ]);
    expect(provingRows.get('rtdb.semantic.read-cascade')).toEqual(['rtdb-rules#5']);
    expect(divergingRows.size).toBe(0);
  });

  it('does NOT prove a construct the row scope OMITS, even on a conforming row', () => {
    const { provingRows } = indexConstructScopes([
      registry([row('rtdb-rules#5', { constructs: ['rtdb.semantic.read-cascade'] })]),
    ]);
    expect(provingRows.get('rtdb.semantic.write-cascade')).toBeUndefined();
    expect(
      isProductionVerified({
        scenarios: [],
        provingRows: provingRows.get('rtdb.semantic.write-cascade') ?? [],
      }),
    ).toBe(false);
  });

  it('does NOT prove anything from a row that is not `conforms`', () => {
    for (const status of ['diverged-documented', 'bug', 'unverified', 'unsupported'] as const) {
      const { provingRows } = indexConstructScopes([
        registry([row('rtdb-rules#5', { status, constructs: ['rtdb.semantic.read-cascade'] })]),
      ]);
      expect(provingRows.get('rtdb.semantic.read-cascade')).toBeUndefined();
    }
  });

  it('does NOT prove anything from a conforming row that is not `oracle-backed`', () => {
    const { provingRows } = indexConstructScopes([
      registry([
        row('rtdb-rules#5', { automation: 'unit-backed', constructs: ['rtdb.semantic.read-cascade'] }),
      ]),
    ]);
    expect(provingRows.get('rtdb.semantic.read-cascade')).toBeUndefined();
  });

  it('does NOT prove anything from a row on an SDK surface — only a rules ENGINE decides ALLOW/DENY', () => {
    const { provingRows } = indexConstructScopes([
      registry([row('rtdb#1', { surface: 'rtdb', constructs: ['rtdb.semantic.read-cascade'] })]),
    ]);
    expect(provingRows.get('rtdb.semantic.read-cascade')).toBeUndefined();
  });

  it('a diverged or bug row CONTAMINATES its scope rather than proving it', () => {
    const { provingRows, divergingRows } = indexConstructScopes([
      registry([
        row('firestore-rules#161', {
          surface: 'firestore-rules',
          status: 'diverged-documented',
          constructs: ['firestore.method.string.toUtf8'],
        }),
      ]),
    ]);
    expect(divergingRows.get('firestore.method.string.toUtf8')).toEqual(['firestore-rules#161']);
    expect(provingRows.size).toBe(0);
  });

  it('carries all three rules engines: an rtdb-rules row is a rules-engine row', () => {
    expect([...RULES_ENGINE_SURFACES].sort()).toEqual(['firestore-rules', 'rtdb-rules', 'storage-rules']);
  });
});

describe('the real graph', () => {
  const { provingRows } = indexConstructScopes(surfaceRegistries);

  it('credits the three RTDB cascade semantics behaviorally — no ruleset can express them syntactically', () => {
    for (const id of [
      'rtdb.semantic.read-cascade',
      'rtdb.semantic.write-cascade',
      'rtdb.semantic.validate-non-cascade',
    ]) {
      const construct = coverageReport.engines
        .flatMap((e) => e.constructs)
        .find((c) => c.id === id)!;
      expect(construct.verifiedBy).toEqual([]);
      expect(construct.verifiedByRows.length).toBeGreaterThan(0);
      expect(
        isProductionVerified({ scenarios: construct.verifiedBy, provingRows: construct.verifiedByRows }),
      ).toBe(true);
    }
  });

  it('leaves deny-by-default UNCREDITED and out of the coverage ratio: a denial is a non-event', () => {
    for (const id of ['rtdb.semantic.deny-by-default', 'storage.semantic.deny-by-default']) {
      const construct = coverageReport.engines
        .flatMap((e) => e.constructs)
        .find((c) => c.id === id)!;
      // Excluded from the denominator: no scenario's AST can carry it and no
      // single captured verdict positively demonstrates it.
      expect(construct.unattributable).toBeTruthy();
      expect(construct.verifiedBy).toEqual([]);
      expect(provingRows.get('rtdb.semantic.deny-by-default')).toBeUndefined();
    }
    const rtdb = coverageReport.engines.find((e) => e.engine === 'rtdb')!;
    expect(rtdb.constructs.filter((c) => !c.unattributable).length).toBe(rtdb.totalConstructs);
    expect(rtdb.constructs.some((c) => c.id === 'rtdb.semantic.deny-by-default')).toBe(true);
  });

  it('the coverage report and the derivation agree, construct for construct', () => {
    for (const engine of coverageReport.engines) {
      const verified = engine.constructs
        .filter((c) => !c.unattributable)
        .filter((c) => isProductionVerified({ scenarios: c.verifiedBy, provingRows: c.verifiedByRows }));
      expect(verified.length).toBe(engine.verifiedConstructs);
    }
  });
});


// ── Contamination: negative evidence dominates positive evidence ───────────

describe('contamination: a construct the engine is KNOWN WRONG about is never verified', () => {
  it('NEGATIVE — a diverged-documented row withholds credit despite captured scenarios AND a conforming oracle-backed row', () => {
    // The fake: a construct carries every kind of positive evidence there is —
    // corpus scenarios that exercise it, a conforming oracle-backed row that
    // scopes it — while ANOTHER row stands in the registry saying the simulator
    // is known wrong about it. Counting it verified publishes a high (even 100%)
    // number for a construct the repo itself documents as broken.
    const index = indexConstructScopes([
      registry([
        row('firestore-rules#1', { surface: 'firestore-rules', constructs: ['firestore.function.get'] }),
        row('firestore-rules#2', { surface: 'firestore-rules', status: 'diverged-documented', constructs: ['firestore.function.get'] }),
      ]),
    ]);
    const evidence = productionEvidenceFor('firestore.function.get', index, ['scenario-a', 'scenario-b']);

    expect(evidence.scenarios.length).toBe(2);
    expect(evidence.provingRows).toEqual(['firestore-rules#1']);
    expect(evidence.divergingRows).toEqual(['firestore-rules#2']);
    expect(isProductionVerified(evidence)).toBe(false);
    expect(describeProductionEvidence(evidence)).toContain('NOT production-verified');
  });

  it('NEGATIVE — a `bug` row contaminates exactly as a `diverged-documented` row does', () => {
    const index = indexConstructScopes([
      registry([row('storage-rules#9', { surface: 'storage-rules', status: 'bug', constructs: ['storage.operator.in'] })]),
    ]);
    expect(isProductionVerified(productionEvidenceFor('storage.operator.in', index, ['scenario-a']))).toBe(false);
  });

  it('POSITIVE — the same construct IS verified once no divergence covers it', () => {
    const index = indexConstructScopes([
      registry([row('firestore-rules#1', { surface: 'firestore-rules', constructs: ['firestore.function.get'] })]),
    ]);
    expect(isProductionVerified(productionEvidenceFor('firestore.function.get', index, ['scenario-a']))).toBe(true);
  });

  it('NEGATIVE — no evidence at all is never verification (support is positive)', () => {
    expect(isProductionVerified({ scenarios: [], provingRows: [], divergingRows: [] })).toBe(false);
  });

  it('a divergence on an SDK surface does NOT contaminate a language construct', () => {
    // Only rows about the rules ENGINE speak about the language; an SDK-surface
    // divergence is a statement about a client library.
    const index = indexConstructScopes([
      registry([row('firestore#7', { surface: 'firestore', status: 'diverged-documented', constructs: ['firestore.function.get'] })]),
    ]);
    const evidence = productionEvidenceFor('firestore.function.get', index, ['scenario-a']);
    expect(evidence.divergingRows).toEqual([]);
    expect(isProductionVerified(evidence)).toBe(true);
  });
});

describe('contamination: the published coverage report obeys the predicate', () => {
  const report = coverageReport as unknown as {
    engines: {
      verifiedConstructs: number;
      constructs: { id: string; contaminatedBy: string[]; productionVerified: boolean; excluded?: unknown }[];
    }[];
  };

  it('no contaminated construct is counted production-verified', () => {
    const violations = report.engines.flatMap((e) =>
      e.constructs.filter((c) => c.contaminatedBy.length > 0 && c.productionVerified).map((c) => c.id),
    );
    expect(violations).toEqual([]);
  });

  it('every construct a diverged/bug row scopes in the SHIPPED registry is marked contaminated', () => {
    const { divergingRows } = indexConstructScopes(surfaceRegistries);
    const byId = new Map(report.engines.flatMap((e) => e.constructs.map((c) => [c.id, c] as const)));
    for (const [id, rows] of divergingRows) {
      expect(byId.get(id)?.contaminatedBy).toEqual(rows);
      expect(byId.get(id)?.productionVerified).toBe(false);
    }
  });

  it('verifiedConstructs equals the count of counted, production-verified constructs', () => {
    for (const engine of report.engines) {
      const counted = engine.constructs.filter((c) => !c.excluded);
      expect(engine.verifiedConstructs).toBe(counted.filter((c) => c.productionVerified).length);
    }
  });
});
