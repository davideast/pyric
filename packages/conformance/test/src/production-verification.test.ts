/**
 * Tests for the ONE production-verification graph.
 *
 * The negative cases carry the weight. `factOf` decides what goes into the
 * coverage report's trust number AND what lets an assurance capability
 * claim `supported` instead of abstaining, so a false positive here is a false
 * security claim downstream. Each way a construct can FAIL to be credited —
 * the row is not conforming, the row is not oracle-backed, the row is not on a
 * rules-engine surface, the row's scope omits the construct, nothing mentions it
 * at all — is driven separately.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  RULES_ENGINE_SURFACES,
  deriveConformanceGraph,
  describeProductionFact,
  describeProductionEvidence,
  indexConstructScopes,
} from '../../src/production-verification.ts';
import { surfaceRegistries } from '../../registry/index.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from '../../registry/types.ts';
import { computeCoverageReport, type CoverageReport } from '../../src/rules-language-analyzer.ts';

let coverageReport: CoverageReport;
beforeAll(async () => { coverageReport = await computeCoverageReport(); }, 20_000);

function row(id: string, over: Partial<CompatibilityRow> = {}): CompatibilityRow {
  return {
    id,
    surface: 'rtdb-rules',
    aliases: [],
    featureKeys: [],
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

function factFrom(over: {
  scenarios?: string[];
  provingRows?: string[];
  divergingRows?: string[];
} = {}) {
  const id = 'rtdb.semantic.test';
  return deriveConformanceGraph({
    scenariosByConstruct: new Map([[id, over.scenarios ?? []]]),
    provingRowsByConstruct: new Map([[id, over.provingRows ?? []]]),
    divergingRowsByConstruct: new Map([[id, over.divergingRows ?? []]]),
  }).factOf(id);
}

describe('DerivedConformanceGraph.factOf', () => {
  it('reports a construct as diverged when negative evidence contradicts positive evidence', () => {
    const scopes = indexConstructScopes([
      registry([
        row('rtdb-rules#4', {
          constructs: ['rtdb.semantic.validate-non-cascade'],
        }),
        row('rtdb-rules#15', {
          status: 'diverged-documented',
          constructs: ['rtdb.semantic.validate-non-cascade'],
        }),
      ]),
    ]);
    const graph = deriveConformanceGraph({
      scenariosByConstruct: new Map(),
      provingRowsByConstruct: scopes.provingRows,
      divergingRowsByConstruct: scopes.divergingRows,
    });

    expect(graph.factOf('rtdb.semantic.validate-non-cascade')).toEqual({
      id: 'rtdb.semantic.validate-non-cascade',
      verdict: 'diverged',
      scenarios: [],
      provingRows: ['rtdb-rules#4'],
      divergingRows: ['rtdb-rules#15'],
    });
  });

  it('credits a construct SYNTACTICALLY: a captured scenario exercises it', () => {
    expect(factFrom({ scenarios: ['r1-auth-only'] }).verdict).toBe('verified');
  });

  it('credits a construct BEHAVIORALLY: a conforming oracle-backed row scopes it', () => {
    expect(factFrom({ provingRows: ['rtdb-rules#5'] }).verdict).toBe('verified');
  });

  it('does NOT credit a construct nothing backs', () => {
    expect(factFrom().verdict).toBe('unverified');
  });
});

describe('describeProductionFact', () => {
  it('leads with the divergence when positive and negative evidence coexist', () => {
    expect(
      describeProductionFact(
        factFrom({
          scenarios: ['r4-validate-structure'],
          provingRows: ['rtdb-rules#4'],
          divergingRows: ['rtdb-rules#15'],
        }),
      ),
    ).toBe('production divergence documented by rules-engine row rtdb-rules#15');
  });
});

describe('describeProductionEvidence', () => {
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
    const scopes = indexConstructScopes([
      registry([row('rtdb-rules#5', { constructs: ['rtdb.semantic.read-cascade'] })]),
    ]);
    const graph = deriveConformanceGraph({
      scenariosByConstruct: new Map(),
      provingRowsByConstruct: scopes.provingRows,
      divergingRowsByConstruct: scopes.divergingRows,
    });
    expect(scopes.provingRows.get('rtdb.semantic.write-cascade')).toBeUndefined();
    expect(graph.factOf('rtdb.semantic.write-cascade').verdict).toBe('unverified');
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
  const scopes = indexConstructScopes(surfaceRegistries);

  it('credits all three RTDB semantics after the ancestor validation fix', () => {
    for (const [id, verdict] of [
      ['rtdb.semantic.read-cascade', 'verified'],
      ['rtdb.semantic.write-cascade', 'verified'],
      ['rtdb.semantic.validate-non-cascade', 'verified'],
    ] as const) {
      const construct = coverageReport.engines
        .flatMap((e) => e.constructs)
        .find((c) => c.id === id)!;
      expect(construct.verifiedBy).toEqual([]);
      expect(construct.verifiedByRows.length).toBeGreaterThan(0);
      expect(construct.verdict).toBe(verdict);
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
      expect(scopes.provingRows.get('rtdb.semantic.deny-by-default')).toBeUndefined();
    }
    const rtdb = coverageReport.engines.find((e) => e.engine === 'rtdb')!;
    expect(rtdb.constructs.filter((c) => !c.unattributable).length).toBe(rtdb.totalConstructs);
    expect(rtdb.constructs.some((c) => c.id === 'rtdb.semantic.deny-by-default')).toBe(true);
  });

  it('the coverage report and the derivation agree, construct for construct', () => {
    for (const engine of coverageReport.engines) {
      const graph = deriveConformanceGraph({
        scenariosByConstruct: new Map(
          engine.constructs.map((construct) => [construct.id, construct.verifiedBy]),
        ),
        provingRowsByConstruct: scopes.provingRows,
        divergingRowsByConstruct: scopes.divergingRows,
      });
      const verified = engine.constructs.filter(
        (construct) => !construct.unattributable && graph.factOf(construct.id).verdict === 'verified',
      );
      for (const construct of engine.constructs) {
        expect(construct.verdict).toBe(graph.factOf(construct.id).verdict);
      }
      expect(verified.length).toBe(engine.verifiedConstructs);
    }
  });
});
