import { describe, expect, it } from 'bun:test';
import type { CompatibilityRow } from '../registry/types.ts';
import {
  deriveAllNodeVerdicts,
  deriveConstructVerdict,
  deriveRegistryRowVerdict,
  loadConformanceGraph,
  renderConformanceVerdicts,
  validationProblems,
  type ConformanceGraph,
} from './conformance-verdicts.ts';

function fakeGraph(overrides: Partial<ConformanceGraph> = {}): ConformanceGraph {
  return {
    snapshotStatus: new Map(), probeClass: new Map(), verifiedBy: new Map(), rows: new Map(),
    divergedBy: new Map(), oracleProvedBy: new Map(), ...overrides,
  };
}

function row(id: string, over: Partial<CompatibilityRow> = {}): CompatibilityRow {
  return {
    id, surface: 'firestore-rules', aliases: [], rowRef: id, rowNumber: null,
    section: 'test', api: 'test', behavior: 'test', status: 'conforms', evidence: 'test',
    risk: [], riskScore: 0, riskReasons: [], automation: 'oracle-backed',
    oracleObservations: [], conformanceTests: [], ...over,
  };
}

describe('conformance verdict projection', () => {
  it('resolves every shipped construct and registry row exactly once', () => {
    const graph = loadConformanceGraph();
    expect(validationProblems(graph)).toEqual([]);
    const verdicts = deriveAllNodeVerdicts(graph);
    expect(Object.keys(verdicts)).toHaveLength(graph.snapshotStatus.size + graph.rows.size);
    expect(Object.values(verdicts).every((value) => ['supported', 'qualified', 'unsupported'].includes(value))).toBe(true);
  });

  it('is deterministic regardless of input record insertion order', () => {
    const left = renderConformanceVerdicts({ z: 'qualified', a: 'supported' });
    const right = renderConformanceVerdicts({ a: 'supported', z: 'qualified' });
    expect(left).toBe(right);
    expect(left.indexOf('"a"')).toBeLessThan(left.indexOf('"z"'));
  });

  it('derives construct support only from complete positive evidence', () => {
    const id = 'firestore.operator.eq';
    const supported = fakeGraph({
      snapshotStatus: new Map([[id, 'accepted']]),
      probeClass: new Map([[id, 'implemented']]),
      verifiedBy: new Map([[id, ['scenario-a']]]),
    });
    expect(deriveConstructVerdict(supported, id)).toBe('supported');
    expect(deriveConstructVerdict({ ...supported, verifiedBy: new Map([[id, []]]) }, id)).toBe('qualified');
    expect(deriveConstructVerdict({ ...supported, divergedBy: new Map([[id, ['firestore-rules#1']]]) }, id)).toBe('unsupported');
    expect(deriveConstructVerdict({ ...supported, probeClass: new Map([[id, 'error']]) }, id)).toBe('unsupported');
  });

  it('qualifies SDK divergence but rejects rules-engine divergence', () => {
    const sdk = row('auth#1', { surface: 'auth', status: 'diverged-documented' });
    const engine = row('firestore-rules#1', { status: 'diverged-documented', constructs: ['x'] });
    expect(deriveRegistryRowVerdict(fakeGraph({ rows: new Map([[sdk.id, sdk]]) }), sdk.id)).toBe('qualified');
    expect(deriveRegistryRowVerdict(fakeGraph({ rows: new Map([[engine.id, engine]]) }), engine.id)).toBe('unsupported');
  });

  it('rejects unscoped rules-engine divergences and unknown construct scopes', () => {
    const unscoped = row('firestore-rules#1', { status: 'bug' });
    const unknown = row('firestore-rules#2', { status: 'bug', constructs: ['ghost'] });
    const problems = validationProblems(fakeGraph({ rows: new Map([[unscoped.id, unscoped], [unknown.id, unknown]]) }));
    expect(problems.some((problem) => problem.includes('declares no'))).toBe(true);
    expect(problems.some((problem) => problem.includes('"ghost"'))).toBe(true);
  });
});
