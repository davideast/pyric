import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES_ENGINE_SURFACES,
  describeProductionEvidence,
  indexConstructScopes,
  isProductionVerified,
  productionEvidenceFor,
} from './rules-engine-rows.ts';
import { surfaceRegistries } from '../registry/index.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from '../registry/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const COVERAGE_REPORT = join(HERE, '..', 'rules-language', 'coverage-report.json');

function row(over: Partial<CompatibilityRow>): CompatibilityRow {
  return {
    id: 'firestore-rules#1',
    surface: 'firestore-rules',
    rowRef: '1',
    section: 'S',
    api: 'a',
    behavior: 'b',
    status: 'conforms',
    automation: 'oracle-backed',
    oracleObservations: [],
    conformanceTests: [],
    riskScore: 0,
    riskReasons: [],
    ...over,
  } as unknown as CompatibilityRow;
}

function registry(rows: CompatibilityRow[]): CompatibilitySurfaceRegistry {
  return { surface: 'rules', compatPath: 'x.md', blocks: [{ kind: 'table', rows }] } as unknown as CompatibilitySurfaceRegistry;
}

describe('production verification: contamination beats credit', () => {
  it('NEGATIVE — a construct scoped by a diverged-documented row is NOT verified, even with captured scenarios AND a conforming oracle-backed row', () => {
    // The fake: a construct carries every kind of positive evidence there is —
    // corpus scenarios that exercise it, and a conforming oracle-backed row that
    // scopes it — while ANOTHER row stands in the registry saying the simulator
    // is known wrong about it. Counting it verified reaches a high (even 100%)
    // number for a construct the repo itself documents as broken.
    const index = indexConstructScopes([
      registry([
        row({ id: 'firestore-rules#1', status: 'conforms', automation: 'oracle-backed', constructs: ['firestore.function.get'] }),
        row({ id: 'firestore-rules#2', status: 'diverged-documented', constructs: ['firestore.function.get'] }),
      ]),
    ]);
    const evidence = productionEvidenceFor('firestore.function.get', index, ['scenario-a', 'scenario-b']);

    expect(evidence.scenarios.length).toBe(2);
    expect(evidence.provingRows).toEqual(['firestore-rules#1']);
    expect(evidence.divergingRows).toEqual(['firestore-rules#2']);
    expect(isProductionVerified(evidence)).toBe(false);
    expect(describeProductionEvidence(evidence).join(' ')).toContain('NOT production-verified');
  });

  it('NEGATIVE — a `bug` row contaminates exactly as a `diverged-documented` row does', () => {
    const index = indexConstructScopes([
      registry([row({ id: 'storage-rules#9', surface: 'storage-rules', status: 'bug', constructs: ['storage.operator.in'] })]),
    ]);
    const evidence = productionEvidenceFor('storage.operator.in', index, ['scenario-a']);
    expect(isProductionVerified(evidence)).toBe(false);
  });

  it('POSITIVE — the same construct IS verified once no divergence covers it', () => {
    const index = indexConstructScopes([
      registry([row({ id: 'firestore-rules#1', status: 'conforms', automation: 'oracle-backed', constructs: ['firestore.function.get'] })]),
    ]);
    const evidence = productionEvidenceFor('firestore.function.get', index, ['scenario-a']);
    expect(isProductionVerified(evidence)).toBe(true);
  });

  it('NEGATIVE — no evidence at all is never verification (support is positive)', () => {
    expect(isProductionVerified({ scenarios: [], provingRows: [], divergingRows: [] })).toBe(false);
  });

  it('a divergence on an SDK surface does NOT contaminate a language construct', () => {
    // Only rows about the rules ENGINE speak about the language. An SDK-surface
    // divergence is a statement about a client library.
    const index = indexConstructScopes([
      registry([row({ id: 'firestore#7', surface: 'firestore', status: 'diverged-documented', constructs: ['firestore.function.get'] })]),
    ]);
    const evidence = productionEvidenceFor('firestore.function.get', index, ['scenario-a']);
    expect(evidence.divergingRows).toEqual([]);
    expect(isProductionVerified(evidence)).toBe(true);
  });

  it('all three rules engines can prove and contaminate', () => {
    expect([...RULES_ENGINE_SURFACES].sort()).toEqual(['firestore-rules', 'rtdb-rules', 'storage-rules']);
  });
});

describe('production verification: the published coverage report obeys the predicate', () => {
  const report = JSON.parse(readFileSync(COVERAGE_REPORT, 'utf8')) as {
    engines: {
      engine: string;
      verifiedConstructs: number;
      constructs: { id: string; verifiedBy: string[]; provenBy: string[]; contaminatedBy: string[]; productionVerified: boolean; excluded?: unknown }[];
    }[];
  };

  it('no contaminated construct is counted production-verified', () => {
    const violations = report.engines.flatMap((e) =>
      e.constructs.filter((c) => c.contaminatedBy.length > 0 && c.productionVerified).map((c) => c.id),
    );
    expect(violations).toEqual([]);
  });

  it('every construct scoped by a diverged/bug row in the SHIPPED registry is marked contaminated in the report', () => {
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
