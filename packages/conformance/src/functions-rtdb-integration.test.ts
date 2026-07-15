import { describe, expect, it } from 'bun:test';
import { functionsRtdbRegistry, functionsRtdbRows } from '../registry/functions-rtdb.ts';
import { scoreBlock } from './generate-docs.ts';
import { surfaceRecordProblems } from '../surfaces/load.ts';

const integrationRecord = {
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
    expect(surfaceRecordProblems('fixture.ts', integrationRecord)).toEqual([]);
  });

  it('requires contractSource and rejects every mirror/native breadth field', () => {
    const problems = surfaceRecordProblems('fixture.ts', {
      ...integrationRecord,
      contractSource: undefined,
      censusSurface: 'database',
      upstream: 'firebase-functions/v2/database',
      mirrors: ['pyric-functions'],
      symbolSource: 'src/index.ts',
    });
    expect(problems).toEqual([
      "surfaces/fixture.ts: integration descriptor missing 'contractSource'",
      "surfaces/fixture.ts: integration descriptor must not declare 'censusSurface'",
      "surfaces/fixture.ts: integration descriptor must not declare 'upstream'",
      "surfaces/fixture.ts: integration descriptor must not declare 'mirrors'",
      "surfaces/fixture.ts: integration descriptor must not declare 'symbolSource'",
    ]);
  });

  it('does not let mirror/native descriptors smuggle in an integration contract', () => {
    const mirror = surfaceRecordProblems('mirror.ts', {
      ...integrationRecord,
      kind: 'mirror',
      censusSurface: 'database',
      upstream: 'firebase/database',
      mirrors: ['pyric/database'],
    });
    const native = surfaceRecordProblems('native.ts', {
      ...integrationRecord,
      kind: 'native',
      symbolSource: 'src/index.ts',
    });
    expect(mirror).toContain("surfaces/mirror.ts: mirror descriptor must not declare 'contractSource'");
    expect(native).toContain("surfaces/native.ts: native descriptor must not declare 'contractSource'");
  });
});

describe('integration compatibility score', () => {
  it('uses the signed row inventory and the cross-package scoreboard link', () => {
    const rowStatuses = Object.fromEntries(functionsRtdbRows.map((row) => [row.id, row.status]));
    const block = scoreBlock(functionsRtdbRegistry, {
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
    });
    expect(block).toContain('<strong>Surface:</strong> integration contract <span>(unchanged upstream source; breadth is the signed row inventory)</span>');
    expect(block).toContain('<span class="compat-stat-pct">92.3%</span>');
    expect(block).toContain('<p class="compat-stat-denom">12 of 13 tracked behaviors</p>');
    expect(block).toContain('../../../pyric/docs/conformance/SCORES.md');
    expect(block).not.toContain('Public surface measures whether exports exist');
  });
});
