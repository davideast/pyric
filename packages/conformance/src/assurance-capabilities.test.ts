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
  pinningDependencies,
  renderArtifactJson,
  renderGeneratedTs,
  validationProblems,
  type ConformanceGraph,
} from './assurance-capabilities.ts';
import { capabilityReasons } from '../assurance-capabilities/generated.ts';
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
    expect(pinningDependencies(derived)).toEqual([
      {
        kind: 'construct',
        id: 'firestore.operator.eq',
        verdict: 'unsupported',
        snapshot: 'accepted',
        probe: 'implemented',
        productionVerified: false,
        divergedBy: ['firestore-rules#166'],
      },
    ]);
  });

  it('records production verification as a boolean, never the scenarios that produced it', () => {
    const many = fakeGraph({
      ...supported,
      verifiedBy: new Map([['firestore.operator.eq', ['s1', 's2', 's3']]]),
    });
    const [dependency] = deriveCapability(many, capability({ dependencies: dep })).dependencies;
    expect(dependency).toEqual({
      kind: 'construct',
      id: 'firestore.operator.eq',
      verdict: 'supported',
      snapshot: 'accepted',
      probe: 'implemented',
      productionVerified: true,
      divergedBy: [],
    });
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
    for (const item of derived) expect(pinningDependencies(item).length).toBeGreaterThan(0);
  });

  it('renders an abstention reason on READ from the facts, for every capability a probe must abstain on', () => {
    for (const item of ASSURANCE_ENGINE_CAPABILITIES.filter((c) => c.status !== 'supported')) {
      const reasons = capabilityReasons(item);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('the committed artifact and generated module match the graph (no drift)', () => {
    expect(renderArtifactJson(buildArtifact(derived))).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
    expect(ASSURANCE_ENGINE_CAPABILITIES.map((c) => `${c.id}:${c.status}`)).toEqual(
      derived.map((c) => `${c.id}:${c.status}`),
    );
    expect(renderGeneratedTs(derived)).toContain('ASSURANCE_ENGINE_CAPABILITIES');
  });
});

/**
 * THE STANDING CONSTRAINT (see the generator header): a durable artifact carries
 * facts about the thing it describes, never a whole-population aggregate.
 *
 * The artifacts once baked the corpus scenario COUNT into each construct's
 * evidence sentence ("production-verified by 19 captured scenario(s)"). That
 * count belongs to the corpus, so capturing ONE scenario anywhere rewrote dozens
 * of capabilities that nothing had happened to: the diff lied about causality, a
 * real `qualified -> supported` event drowned in the churn, and
 * `compat:assurance:check` failed on branches that never touched assurance.
 *
 * The property these tests hold: the artifacts change IF AND ONLY IF a verdict
 * changes. The perturbation below is the exact event that used to churn them.
 */
describe('churn invariance: the artifacts move only when a verdict moves', () => {
  /** Every construct the corpus already verifies gains one more scenario, as if a
   *  PR captured a scenario that happens to exercise it. Counts move; no verdict
   *  can move, because `productionVerified` was already true for each of them. */
  function withAnUnrelatedScenarioCaptured(graph: ConformanceGraph): ConformanceGraph {
    const verifiedBy = new Map(graph.verifiedBy);
    let perturbed = 0;
    for (const [id, scenarios] of verifiedBy) {
      if (scenarios.length === 0) continue;
      verifiedBy.set(id, [...scenarios, 'synthetic-unrelated-scenario']);
      perturbed++;
    }
    expect(perturbed).toBeGreaterThan(0);
    return { ...graph, verifiedBy };
  }

  const before = deriveAllCapabilities(graph);
  const after = deriveAllCapabilities(withAnUnrelatedScenarioCaptured(graph));

  it('no verdict moves under the perturbation (it is a pure count change)', () => {
    expect(after.map((c) => `${c.id}:${c.status}`)).toEqual(before.map((c) => `${c.id}:${c.status}`));
    expect(after.flatMap((c) => c.dependencies.map((d) => `${c.id}/${d.id}:${d.verdict}`))).toEqual(
      before.flatMap((c) => c.dependencies.map((d) => `${c.id}/${d.id}:${d.verdict}`)),
    );
  });

  it('both artifacts are BYTE-IDENTICAL under the perturbation', () => {
    expect(renderArtifactJson(buildArtifact(after))).toBe(renderArtifactJson(buildArtifact(before)));
    expect(renderGeneratedTs(after)).toBe(renderGeneratedTs(before));
  });

  it('a verdict change DOES move the artifacts (the invariance is not vacuous)', () => {
    // A construct some shipped capability actually depends on: break the simulator
    // on it, and the artifacts must move.
    const depended = before
      .flatMap((c) => c.dependencies)
      .find((d) => d.kind === 'construct' && d.verdict === 'supported');
    expect(depended).toBeDefined();
    const broken: ConformanceGraph = {
      ...graph,
      probeClass: new Map(graph.probeClass).set(depended!.id, 'error'),
    };
    expect(renderArtifactJson(buildArtifact(deriveAllCapabilities(broken)))).not.toBe(
      renderArtifactJson(buildArtifact(before)),
    );
  });

  it('no durable artifact carries a population aggregate', () => {
    for (const text of [renderArtifactJson(buildArtifact(before)), renderGeneratedTs(before)]) {
      expect(text).not.toContain('captured scenario(s)');
      expect(text).not.toMatch(/production-verified by \d+/);
    }
  });
});
