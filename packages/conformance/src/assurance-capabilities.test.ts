/**
 * Tests for the assurance-capability derivation.
 *
 * The property under test is the one the whole seam exists for: a capability's
 * status is COMPUTED from the conformance graph and cannot be asserted. Each
 * validator rule and each derivation rule is driven through the same code path
 * the generator uses, with synthetic graphs for the negative cases.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildArtifact,
  deriveAllCapabilities,
  deriveCapability,
  loadConformanceGraph,
  renderArtifactJson,
  renderGeneratedTs,
  validationProblems,
  type ConformanceGraph,
} from './assurance-capabilities.ts';
import {
  capabilityRecordProblems,
  loadAssuranceCapabilityRecords,
  type LoadedCapability,
} from '../assurance-capabilities/load.ts';
import { ASSURANCE_ENGINE_CAPABILITIES } from '../assurance-capabilities/generated.ts';
import type { CompatibilityRow } from '../registry/types.ts';
import artifact from '../assurance-capabilities/capabilities.json' with { type: 'json' };

const graph = loadConformanceGraph();
const records = loadAssuranceCapabilityRecords();

/** A graph with exactly the entries a test needs. */
function fakeGraph(overrides: Partial<ConformanceGraph> = {}): ConformanceGraph {
  return {
    snapshotStatus: new Map(),
    probeClass: new Map(),
    verifiedBy: new Map(),
    rows: new Map(),
    divergedBy: new Map(),
    oracleProvedBy: new Map(),
    ...overrides,
  };
}

function row(id: string, over: Partial<CompatibilityRow> = {}): CompatibilityRow {
  return {
    id,
    surface: 'firestore-rules',
    aliases: [],
    rowRef: id,
    rowNumber: null,
    section: 'test',
    api: 'test',
    behavior: 'test',
    status: 'conforms',
    evidence: 'test',
    risk: [],
    riskScore: 0,
    riskReasons: [],
    automation: 'oracle-backed',
    oracleObservations: [],
    conformanceTests: [],
    ...over,
  };
}

function capability(over: Partial<LoadedCapability> = {}): LoadedCapability {
  return {
    id: 'firestore.test',
    service: 'firestore',
    description: 'test capability',
    dependencies: [],
    ...over,
  };
}

describe('records', () => {
  it('loads every shipped record with a service-prefixed id and at least one dependency', () => {
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.id.startsWith(`${record.service}.`)).toBe(true);
      expect(record.dependencies.length).toBeGreaterThan(0);
    }
  });

  it('rejects a record that asserts a status (status is derived, never authored)', () => {
    const problems = capabilityRecordProblems('firestore.test', {
      service: 'firestore',
      description: 'x',
      status: 'supported',
      dependencies: [{ kind: 'construct', id: 'firestore.binding.request' }],
    });
    expect(problems.some((p) => p.includes('DERIVED'))).toBe(true);
  });

  it('rejects a record with no dependencies (an unfalsifiable claim)', () => {
    const problems = capabilityRecordProblems('firestore.test', {
      service: 'firestore',
      description: 'x',
      dependencies: [],
    });
    expect(problems.some((p) => p.includes('at least one dependency'))).toBe(true);
  });
});

describe('validator rules', () => {
  it('the shipped graph and records resolve with no problems', () => {
    expect(validationProblems(graph, records)).toEqual([]);
  });

  it('rejects a construct dependency the language snapshots do not enumerate', () => {
    const problems = validationProblems(
      fakeGraph({ snapshotStatus: new Map([['firestore.binding.request', 'accepted']]) }),
      [capability({ dependencies: [{ kind: 'construct', id: 'firestore.binding.nonexistent' }] })],
    );
    expect(problems).toEqual([
      'capability firestore.test depends on construct "firestore.binding.nonexistent", which no rules-language snapshot enumerates',
    ]);
  });

  it('rejects a registry-row dependency no registry declares', () => {
    const problems = validationProblems(fakeGraph(), [
      capability({ dependencies: [{ kind: 'registry-row', id: 'auth#9999' }] }),
    ]);
    expect(problems).toEqual([
      'capability firestore.test depends on registry row "auth#9999", which no registry declares',
    ]);
  });

  it('rejects a diverged rules-engine row that declares no construct scope', () => {
    const diverged = row('firestore-rules#999', { status: 'diverged-documented' });
    const problems = validationProblems(fakeGraph({ rows: new Map([[diverged.id, diverged]]) }), []);
    expect(problems).toEqual([
      "registry row firestore-rules#999 is \"diverged-documented\" on rules-engine surface firestore-rules but declares no 'constructs' scope; a divergence with no scope contaminates no capability",
    ]);
  });

  it('rejects a row whose construct scope names a construct that does not exist', () => {
    const scoped = row('firestore-rules#999', { status: 'bug', constructs: ['firestore.binding.ghost'] });
    const problems = validationProblems(fakeGraph({ rows: new Map([[scoped.id, scoped]]) }), []);
    expect(problems).toEqual([
      'registry row firestore-rules#999 lists construct "firestore.binding.ghost", which no rules-language snapshot enumerates',
    ]);
  });
});

describe('construct derivation', () => {
  const supported = fakeGraph({
    snapshotStatus: new Map([['firestore.operator.eq', 'accepted']]),
    probeClass: new Map([['firestore.operator.eq', 'implemented']]),
    verifiedBy: new Map([['firestore.operator.eq', ['scenario-a']]]),
  });
  const dep = [{ kind: 'construct' as const, id: 'firestore.operator.eq' }];

  it('accepted + implemented + production-verified is supported', () => {
    expect(deriveCapability(supported, capability({ dependencies: dep })).status).toBe('supported');
  });

  it('a snapshot-rejected construct is unsupported', () => {
    const g = fakeGraph({ ...supported, snapshotStatus: new Map([['firestore.operator.eq', 'rejected']]) });
    expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('unsupported');
  });

  it('a construct the capability probe cannot evaluate is unsupported', () => {
    for (const classification of ['unsupported', 'error'] as const) {
      const g = fakeGraph({ ...supported, probeClass: new Map([['firestore.operator.eq', classification]]) });
      expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('unsupported');
    }
  });

  it('an unprobeable construct is qualified, never supported', () => {
    const g = fakeGraph({ ...supported, probeClass: new Map([['firestore.operator.eq', 'unprobeable']]) });
    expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('qualified');
  });

  it('an unprobed construct (the whole RTDB language) is qualified, never supported', () => {
    const g = fakeGraph({ ...supported, snapshotStatus: new Map([['firestore.operator.eq', 'unprobed']]) });
    expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('qualified');
  });

  it('an implemented but never production-verified construct is qualified', () => {
    const g = fakeGraph({ ...supported, verifiedBy: new Map([['firestore.operator.eq', []]]) });
    expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('qualified');
  });

  it('a conforming oracle-backed rules-engine row is the second production-verification path', () => {
    const g = fakeGraph({
      ...supported,
      verifiedBy: new Map([['firestore.operator.eq', []]]),
      oracleProvedBy: new Map([['firestore.operator.eq', ['firestore-rules#163']]]),
    });
    expect(deriveCapability(g, capability({ dependencies: dep })).status).toBe('supported');
  });

  it('a rules-engine divergence covering the construct forces unsupported', () => {
    const g = fakeGraph({ ...supported, divergedBy: new Map([['firestore.operator.eq', ['firestore-rules#166']]]) });
    const derived = deriveCapability(g, capability({ dependencies: dep }));
    expect(derived.status).toBe('unsupported');
    expect(derived.reasons.join(' ')).toContain('firestore-rules#166');
  });
});

describe('registry-row derivation', () => {
  function withRow(over: Partial<CompatibilityRow>) {
    const r = row('x#1', over);
    return deriveCapability(
      fakeGraph({ rows: new Map([[r.id, r]]) }),
      capability({ dependencies: [{ kind: 'registry-row', id: r.id }] }),
    ).status;
  }

  it('a conforming row is supported', () => {
    expect(withRow({ status: 'conforms' })).toBe('supported');
  });

  it('an unverified row is qualified', () => {
    expect(withRow({ status: 'unverified' })).toBe('qualified');
  });

  it('a bug or unsupported row is unsupported', () => {
    expect(withRow({ status: 'bug' })).toBe('unsupported');
    expect(withRow({ status: 'unsupported' })).toBe('unsupported');
  });

  it('a diverged RULES-ENGINE row is unsupported: the verdict machinery is known wrong', () => {
    expect(withRow({ status: 'diverged-documented', surface: 'storage-rules' })).toBe('unsupported');
  });

  it('a diverged SDK row is qualified: the setup, not the verdict, differs from production', () => {
    expect(withRow({ status: 'diverged-documented', surface: 'auth' })).toBe('qualified');
  });
});

describe('unbacked dependency', () => {
  it('forces unsupported: no evidence is not support', () => {
    const derived = deriveCapability(
      fakeGraph(),
      capability({
        dependencies: [{ kind: 'unbacked', behavior: 'atomic multi-write commit', reason: 'not modeled' }],
      }),
    );
    expect(derived.status).toBe('unsupported');
  });

  it('cannot be lifted by a fully supported sibling dependency', () => {
    const g = fakeGraph({
      snapshotStatus: new Map([['firestore.operator.eq', 'accepted']]),
      probeClass: new Map([['firestore.operator.eq', 'implemented']]),
      verifiedBy: new Map([['firestore.operator.eq', ['scenario-a']]]),
    });
    const derived = deriveCapability(
      g,
      capability({
        dependencies: [
          { kind: 'construct', id: 'firestore.operator.eq' },
          { kind: 'unbacked', behavior: 'listener re-evaluation', reason: 'not modeled' },
        ],
      }),
    );
    expect(derived.status).toBe('unsupported');
  });
});

describe('the shipped derivation', () => {
  const derived = deriveAllCapabilities();

  it('never rates a capability above its weakest dependency', () => {
    const order = { unsupported: 0, qualified: 1, supported: 2 } as const;
    for (const item of derived) {
      const weakest = Math.min(...item.dependencies.map((d) => order[d.verdict]));
      expect(order[item.status]).toBe(weakest);
    }
  });

  it('no supported capability depends on anything rejected, unsupported, unverified, or diverged', () => {
    for (const item of derived.filter((c) => c.status === 'supported')) {
      for (const dep of item.dependencies) expect(dep.verdict).toBe('supported');
    }
  });

  it('cites the graph evidence that pinned each status', () => {
    for (const item of derived) expect(item.reasons.length).toBeGreaterThan(0);
  });

  it('the committed artifact and generated module match the graph (no drift)', () => {
    expect(renderArtifactJson(buildArtifact(derived))).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
    expect(ASSURANCE_ENGINE_CAPABILITIES.map((c) => `${c.id}:${c.status}`)).toEqual(
      derived.map((c) => `${c.id}:${c.status}`),
    );
    expect(renderGeneratedTs(derived)).toContain('ASSURANCE_ENGINE_CAPABILITIES');
  });
});
