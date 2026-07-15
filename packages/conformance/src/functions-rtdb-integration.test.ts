import { beforeAll, describe, expect, it } from 'bun:test';
import { functionsRtdbRegistry, functionsRtdbRows } from '../registry/functions-rtdb.ts';
import { scoreBlock } from './generate-docs.ts';
import { surfaceRecordProblems } from '../surfaces/load.ts';
import { SURFACE_CONTRACT_SCHEMA } from '../surfaces/types.ts';
import { deriveConformanceModel, type ConformanceModel } from './conformance-model.ts';

let projection: ConformanceModel['documentation'];
beforeAll(async () => { projection = (await deriveConformanceModel()).documentation; }, 20_000);

const integrationRecord = {
  schema: SURFACE_CONTRACT_SCHEMA,
  order: 1,
  kind: 'integration',
  registry: 'functions-rtdb',
  contractSource: 'firebase-functions/v2/database#onValueCreated',
  observationPrefixes: ['functions-rtdb-'],
  coverage: true,
  scopeNote: 'unchanged upstream source through a runtime seam',
  captureRigs: ['functions-rtdb'],
};

describe('integration surface descriptors', () => {
  it('accepts a contract source without pretending there is a mirror census', () => {
    expect(surfaceRecordProblems('fixture.json', integrationRecord)).toEqual([]);
  });

  it('requires contractSource and rejects every mirror/native breadth field', () => {
    const problems = surfaceRecordProblems('fixture.json', {
      ...integrationRecord,
      contractSource: undefined,
      censusSurface: 'database',
      upstream: 'firebase-functions/v2/database',
      mirrors: ['pyric-functions'],
      symbolSource: 'src/index.ts',
    });
    expect(problems.some((problem) => problem.includes('contractSource'))).toBe(true);
    for (const field of ['censusSurface', 'upstream', 'mirrors', 'symbolSource']) {
      expect(problems.some((problem) => problem.includes(field))).toBe(true);
    }
  });

  it('does not let mirror/native descriptors smuggle in an integration contract', () => {
    const mirror = surfaceRecordProblems('mirror.json', {
      ...integrationRecord,
      kind: 'mirror',
      censusSurface: 'database',
      upstream: 'firebase/database',
      mirrors: ['pyric/database'],
      dispositions: [],
    });
    const native = surfaceRecordProblems('native.json', {
      ...integrationRecord,
      kind: 'native',
      symbolSource: 'src/index.ts',
    });
    expect(mirror.some((problem) => problem.includes('contractSource'))).toBe(true);
    expect(native.some((problem) => problem.includes('contractSource'))).toBe(true);
  });
});

describe('integration compatibility score', () => {
  it('uses the signed row inventory and the cross-package scoreboard link', () => {
    const rowStatuses = Object.fromEntries(functionsRtdbRows.map((row) => [row.id, row.status]));
    const block = scoreBlock(functionsRtdbRegistry, { ...projection, coverageBaseline: {
      generatedAt: 'test',
      services: { 'functions-rtdb': { integration: true } },
      overall: {
        publicSurface: {
          runtime: { mapped: 0, denominator: 0, pct: 0 },
          types: { mapped: 0, denominator: 0, pct: 0 },
        },
      },
      rowStatuses,
      highRiskUnverified: [],
      orphanObservations: [],
      entryPathVerdicts: {},
    } });
    expect(block).toContain('<strong>Surface:</strong> integration contract <span>(unchanged upstream source; breadth is the signed row inventory)</span>');
    expect(block).toContain('<span class="compat-stat-pct">92.3%</span>');
    expect(block).toContain('<p class="compat-stat-denom">12 of 13 tracked behaviors</p>');
    expect(block).toContain('../../../pyric/docs/conformance/SCORES.md');
    expect(block).not.toContain('Public surface measures whether exports exist');
  });
});
