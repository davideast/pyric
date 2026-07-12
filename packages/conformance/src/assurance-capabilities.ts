#!/usr/bin/env bun
/**
 * Derives the assurance engine's capabilities from the conformance graph.
 *
 * WHY THIS EXISTS
 *
 * An adversarial assurance campaign probes a user's security rules for
 * authorization gaps by running mutated operations against the local rules
 * simulator. Every verdict it reports rests on a claim: "the simulator can
 * DECIDE this class of operation faithfully". Where it cannot, the probe must
 * ABSTAIN (report an engine gap) instead of reporting "no counterexample" —
 * silence from a simulator that cannot see the behavior is not evidence of
 * safety.
 *
 * Those claims used to be a hand-maintained list. A hand-maintained list drifts:
 * the simulator changes, the conformance chain finds a divergence, and the list
 * keeps saying `supported`. The abstention decision then rests on a human's
 * stale memory rather than on evidence. This generator removes the assertion
 * seam: a capability's status is COMPUTED from the graph, never authored.
 *
 * THE DIVISION OF LABOUR
 *
 *   The human declares WHAT a capability needs — one authored record per
 *   capability in `assurance-capabilities/<capability-id>.ts`, listing its
 *   dependencies. Records carry no status; there is no field to assert one in
 *   (the loader rejects a record that carries `status`).
 *
 *   The graph decides WHETHER the claim holds — this file reads the conformance
 *   evidence for each dependency and computes the status.
 *
 * THE GRAPH INPUTS
 *
 *   1. `rules-language/<engine>.json` — the per-construct snapshot, whose
 *      `status` is the PRODUCTION Rules Test API's verdict on whether the
 *      construct is real language surface (accepted / rejected / unprobeable),
 *      or `unprobed` where no Test API exists (all of RTDB).
 *   2. `rules-language/capability-report.json` — what the local SIMULATOR does
 *      with each construct (implemented / unsupported / error / unprobeable).
 *   3. `rules-language/coverage-report.json` — `verifiedBy`: which
 *      production-captured corpus scenarios exercise the construct. A construct
 *      with an empty `verifiedBy` has never been checked against production
 *      behavior, only against production's willingness to PARSE it.
 *   4. `registry/*.ts` — the compatibility rows, including the rules-engine
 *      fidelity rows in `registry/rules.ts`. A `diverged-documented` or `bug`
 *      rules-engine row declares (via `CompatibilityRow.constructs`) the
 *      language constructs its divergence contaminates.
 *
 * THE DERIVATION
 *
 * Each dependency gets a verdict on the same three-value lattice as the
 * capability status, and the capability's status is the WEAKEST verdict among
 * its dependencies (unsupported < qualified < supported). Support is positive:
 * a dependency reaches `supported` only when the graph actively backs it, so
 * absence of evidence can never produce a security claim.
 *
 *   construct dependency
 *     unsupported  snapshot `rejected` (production refuses the construct the
 *                  simulator claims to implement), OR the capability probe
 *                  classifies it `unsupported`/`error` (the simulator cannot
 *                  evaluate it), OR a `diverged-documented`/`bug` RULES-ENGINE
 *                  row lists it in `constructs` (the simulator is known wrong
 *                  about it — a known-wrong engine must not underwrite a
 *                  security claim).
 *     qualified    the graph is silent rather than negative: the capability
 *                  probe could not probe it (`unprobeable`), or the snapshot is
 *                  `unprobed`/`unprobeable` (no production acceptance evidence —
 *                  the whole RTDB language sits here), or nothing
 *                  production-verifies it (see below).
 *     supported    snapshot `accepted` AND capability probe `implemented` AND
 *                  production-verified (which, by the shared predicate, already
 *                  requires that no divergence covers it).
 *
 *   PRODUCTION-VERIFIED is not decided here. It is decided by the one shared
 *   predicate in src/rules-engine-rows.ts, which the coverage numerator counts
 *   with too — a construct cannot be verified in the published coverage number
 *   and unverified in the capability graph. Positive evidence earns credit (a
 *   production-captured corpus scenario's AST contains it, or a `conforms` +
 *   `oracle-backed` rules-engine row scopes it); a `diverged-documented`/`bug`
 *   rules-engine row scoping it WITHHOLDS credit and floors the dependency at
 *   `unsupported`, whatever positive evidence also exists. Negative evidence
 *   dominates: a construct the engine is known wrong about can never underwrite
 *   a security claim. An un-annotated row supplies no verification, so a missing
 *   annotation can only hold a capability DOWN, never lift it.
 *
 *   registry-row dependency (auth acquisition, storage rules-engine behavior:
 *   surfaces the language snapshots do not model as constructs)
 *     unsupported  status `bug` or `unsupported`; or `diverged-documented` on a
 *                  RULES-ENGINE surface (firestore-rules / storage-rules) —
 *                  a divergence in the verdict machinery itself.
 *     qualified    status `unverified`; or `diverged-documented` on an SDK
 *                  surface (auth, firestore, …) — the verdict machinery is
 *                  sound but the probe's SETUP (an actor's uid, a session's
 *                  shape) is known to differ from production, so the result
 *                  stands only under that documented caveat.
 *     supported    status `conforms`.
 *
 *   unbacked dependency
 *     unsupported  always. The record declares a behavior the graph does not
 *                  model at all (atomic multi-write commits, listener
 *                  re-evaluation, resumable-upload state). No evidence exists,
 *                  so no support exists. This is the honest home for a
 *                  capability whose defining behavior is outside the graph — it
 *                  cannot borrow support from adjacent constructs it happens to
 *                  touch.
 *
 * VALIDATION (hard failures — the generator exits non-zero in every mode)
 *
 *   - every construct dependency exists in its engine's language snapshot;
 *   - every registry-row dependency exists in some registry;
 *   - every rules-engine row with status `diverged-documented`/`bug` declares a
 *     non-empty `constructs` scope, and every id in it exists in a snapshot —
 *     a divergence with no declared scope would contaminate nothing, which is
 *     exactly the drift this generator exists to prevent;
 *   - every capability declares at least one dependency (loader).
 *
 * OUTPUT
 *
 *   `assurance-capabilities/capabilities.json` — the artifact, with the full
 *   evidence chain per dependency.
 *   `assurance-capabilities/generated.ts` — the same capabilities as a typed,
 *   inlined const (`ASSURANCE_ENGINE_CAPABILITIES`), the shape the assurance
 *   runtime consumes with no filesystem access.
 *
 * USAGE
 *
 *   bun run packages/conformance/src/assurance-capabilities.ts            print the table
 *   bun run packages/conformance/src/assurance-capabilities.ts --write    regenerate
 *   bun run packages/conformance/src/assurance-capabilities.ts --check    fail on drift
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceRegistries, type CompatibilityRow } from '../registry/index.ts';
import {
  RULES_ENGINE_SURFACES,
  describeProductionEvidence,
  indexConstructScopes,
  isProductionVerified,
  productionEvidenceFor,
} from './rules-engine-rows.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';
import { loadAssuranceCapabilityRecords, type LoadedCapability } from '../assurance-capabilities/load.ts';
import type {
  AssuranceCapabilityArtifact,
  AssuranceCapabilityStatus,
  DerivedCapability,
  DerivedDependency,
  DependencyVerdict,
} from '../assurance-capabilities/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_DIR = join(HERE, '..', 'assurance-capabilities');
const LANGUAGE_DIR = join(HERE, '..', 'rules-language');
export const ARTIFACT_PATH = join(CAPABILITY_DIR, 'capabilities.json');
export const GENERATED_TS_PATH = join(CAPABILITY_DIR, 'generated.ts');

/** The rules-engine surfaces and the production-verification predicate are
 *  SHARED with the coverage analyzer (src/rules-engine-rows.ts) — the two
 *  consumers of the conformance graph must not answer "is this construct
 *  production-verified" differently. */


const STATUS_ORDER: Record<AssuranceCapabilityStatus, number> = {
  unsupported: 0,
  qualified: 1,
  supported: 2,
};

function weakest(verdicts: DependencyVerdict[]): AssuranceCapabilityStatus {
  return verdicts.reduce<AssuranceCapabilityStatus>(
    (worst, verdict) => (STATUS_ORDER[verdict] < STATUS_ORDER[worst] ? verdict : worst),
    'supported',
  );
}

interface ConstructReportEntry {
  id: string;
  classification: 'implemented' | 'unsupported' | 'error' | 'unprobeable';
}
interface CoverageReportEntry {
  id: string;
  verifiedBy?: string[];
}

/** The graph, loaded once: everything the derivation reads. */
export interface ConformanceGraph {
  /** construct id -> snapshot status */
  snapshotStatus: Map<string, string>;
  /** construct id -> capability-probe classification */
  probeClass: Map<string, ConstructReportEntry['classification']>;
  /** construct id -> production-captured scenarios that verify it */
  verifiedBy: Map<string, string[]>;
  /** registry row id -> row */
  rows: Map<string, CompatibilityRow>;
  /** construct id -> ids of diverged/bug rules-engine rows that cover it */
  divergedBy: Map<string, string[]>;
  /** construct id -> ids of conforming, oracle-backed rules-engine rows that
   *  cover it (the second production-verification path) */
  oracleProvedBy: Map<string, string[]>;
}

export function loadConformanceGraph(): ConformanceGraph {
  const snapshotStatus = new Map<string, string>();
  for (const snapshot of Object.values(loadAllSnapshots())) {
    for (const construct of snapshot.constructs) snapshotStatus.set(construct.id, construct.status);
  }

  const probeClass = new Map<string, ConstructReportEntry['classification']>();
  const capabilityReport = JSON.parse(readFileSync(join(LANGUAGE_DIR, 'capability-report.json'), 'utf8')) as {
    engines: { constructs: ConstructReportEntry[] }[];
  };
  for (const engine of capabilityReport.engines) {
    for (const construct of engine.constructs) probeClass.set(construct.id, construct.classification);
  }

  const verifiedBy = new Map<string, string[]>();
  const coverageReport = JSON.parse(readFileSync(join(LANGUAGE_DIR, 'coverage-report.json'), 'utf8')) as {
    engines: { constructs: CoverageReportEntry[] }[];
  };
  for (const engine of coverageReport.engines) {
    for (const construct of engine.constructs) verifiedBy.set(construct.id, construct.verifiedBy ?? []);
  }

  const rows = new Map<string, CompatibilityRow>();
  for (const registry of surfaceRegistries) {
    for (const block of registry.blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) rows.set(row.id, row);
    }
  }
  // The construct-scope index (which rows prove a construct, which rows declare
  // the simulator wrong about it) is built by the SHARED module, from the same
  // registries the coverage analyzer reads.
  const { provingRows, divergingRows } = indexConstructScopes(surfaceRegistries);

  return { snapshotStatus, probeClass, verifiedBy, rows, divergedBy: divergingRows, oracleProvedBy: provingRows };
}

/**
 * The validator rules. Returns the problem list (empty = valid). Every problem
 * is a hard failure: the generator refuses to emit an artifact from a graph it
 * cannot resolve.
 */
export function validationProblems(graph: ConformanceGraph, records: LoadedCapability[]): string[] {
  const problems: string[] = [];

  // Rule 1: every rules-engine divergence declares the constructs it
  // contaminates, and every construct scope any row declares is a real
  // construct.
  for (const row of graph.rows.values()) {
    for (const construct of row.constructs ?? []) {
      if (!graph.snapshotStatus.has(construct)) {
        problems.push(`registry row ${row.id} lists construct "${construct}", which no rules-language snapshot enumerates`);
      }
    }
    if (!RULES_ENGINE_SURFACES.has(row.surface)) continue;
    if (row.status !== 'diverged-documented' && row.status !== 'bug') continue;
    if (!row.constructs || row.constructs.length === 0) {
      problems.push(
        `registry row ${row.id} is "${row.status}" on rules-engine surface ${row.surface} but declares no 'constructs' scope; a divergence with no scope contaminates no capability`,
      );
    }
  }

  // Rule 2: every declared dependency resolves in the graph.
  for (const record of records) {
    for (const dep of record.dependencies) {
      if (dep.kind === 'construct' && !graph.snapshotStatus.has(dep.id)) {
        problems.push(`capability ${record.id} depends on construct "${dep.id}", which no rules-language snapshot enumerates`);
      }
      if (dep.kind === 'registry-row' && !graph.rows.has(dep.id)) {
        problems.push(`capability ${record.id} depends on registry row "${dep.id}", which no registry declares`);
      }
    }
  }

  return problems;
}

function deriveConstruct(graph: ConformanceGraph, id: string): DerivedDependency {
  const snapshot = graph.snapshotStatus.get(id) ?? 'missing';
  const probe = graph.probeClass.get(id);
  const evidence: string[] = [];
  const verdicts: DependencyVerdict[] = [];

  evidence.push(`snapshot status "${snapshot}"`);
  if (snapshot === 'rejected') {
    verdicts.push('unsupported');
  } else if (snapshot === 'unprobed' || snapshot === 'unprobeable') {
    verdicts.push('qualified');
  } else {
    verdicts.push('supported');
  }

  evidence.push(`capability probe "${probe ?? 'absent'}"`);
  if (probe === 'unsupported' || probe === 'error' || probe === undefined) {
    verdicts.push('unsupported');
  } else if (probe === 'unprobeable') {
    verdicts.push('qualified');
  } else {
    verdicts.push('supported');
  }

  // Production verification: the ONE predicate (src/rules-engine-rows.ts), the
  // same one the coverage numerator counts with. Positive evidence earns credit;
  // a rules-engine divergence scoping the construct withholds it outright.
  const productionEvidence = productionEvidenceFor(
    id,
    { provingRows: graph.oracleProvedBy, divergingRows: graph.divergedBy },
    graph.verifiedBy.get(id) ?? [],
  );
  evidence.push(...describeProductionEvidence(productionEvidence));
  verdicts.push(isProductionVerified(productionEvidence) ? 'supported' : 'qualified');

  // A construct the engine is KNOWN WRONG about must not underwrite a security
  // claim at all: `qualified` (the graph is merely silent) is not enough — this
  // is negative evidence, and it floors the dependency at `unsupported`, so a
  // probe that depends on it abstains rather than reporting a conclusion.
  if (productionEvidence.divergingRows.length > 0) verdicts.push('unsupported');

  return { kind: 'construct', id, verdict: weakest(verdicts), evidence };
}

function deriveRow(graph: ConformanceGraph, id: string): DerivedDependency {
  const row = graph.rows.get(id);
  if (!row) return { kind: 'registry-row', id, verdict: 'unsupported', evidence: ['row not found in any registry'] };
  const engineRow = RULES_ENGINE_SURFACES.has(row.surface);
  const evidence = [`registry row ${row.id} (${row.surface}) status "${row.status}"`];
  let verdict: DependencyVerdict;
  if (row.status === 'bug' || row.status === 'unsupported') {
    verdict = 'unsupported';
  } else if (row.status === 'diverged-documented') {
    verdict = engineRow ? 'unsupported' : 'qualified';
    evidence.push(
      engineRow
        ? 'divergence is in the rules engine itself: the verdict machinery is known wrong here'
        : 'divergence is in an SDK surface: the verdict machinery is sound, the probe setup is not production-identical',
    );
  } else if (row.status === 'unverified') {
    verdict = 'qualified';
  } else {
    verdict = 'supported';
  }
  return { kind: 'registry-row', id, verdict, evidence };
}

/** Derive one capability from the graph. */
export function deriveCapability(graph: ConformanceGraph, record: LoadedCapability): DerivedCapability {
  const dependencies: DerivedDependency[] = record.dependencies.map((dep) => {
    if (dep.kind === 'construct') return deriveConstruct(graph, dep.id);
    if (dep.kind === 'registry-row') return deriveRow(graph, dep.id);
    return {
      kind: 'unbacked',
      id: dep.behavior,
      verdict: 'unsupported',
      evidence: [`the conformance graph does not model this behavior: ${dep.reason}`],
    };
  });

  const status = weakest(dependencies.map((dep) => dep.verdict));
  const reasons = dependencies
    .filter((dep) => dep.verdict === status)
    .map((dep) => `${dep.id}: ${dep.evidence.join('; ')}`);

  return { id: record.id, service: record.service, status, description: record.description, reasons, dependencies };
}

/** Derive every capability. Throws on any validation problem. */
export function deriveAllCapabilities(): DerivedCapability[] {
  const graph = loadConformanceGraph();
  const records = loadAssuranceCapabilityRecords();
  const problems = validationProblems(graph, records);
  if (problems.length > 0) {
    throw new Error(`assurance-capability graph is not resolvable:\n  - ${problems.join('\n  - ')}`);
  }
  return records.map((record) => deriveCapability(graph, record));
}

const GENERATED_NOTE =
  'GENERATED from the conformance graph by packages/conformance/src/assurance-capabilities.ts. Do not edit by hand; run bun run compat:assurance. Each capability declares its dependencies in packages/conformance/assurance-capabilities/<id>.ts; the status here is DERIVED, never asserted. A capability that is not "supported" means an assurance probe depending on it must abstain (engine-gap), not report a security conclusion.';

export function buildArtifact(capabilities: DerivedCapability[]): AssuranceCapabilityArtifact {
  return {
    generatedNote: GENERATED_NOTE,
    generator: 'packages/conformance/src/assurance-capabilities.ts',
    inputs: [
      'packages/conformance/assurance-capabilities/<capability-id>.ts (authored dependency records)',
      'packages/conformance/rules-language/{firestore,storage,rtdb}.json (construct snapshots)',
      'packages/conformance/rules-language/capability-report.json (simulator capability probe)',
      'packages/conformance/rules-language/coverage-report.json (production-captured verification)',
      'packages/conformance/registry/*.ts (compatibility rows, incl. rules-engine divergences)',
    ],
    capabilities,
  };
}

export function renderArtifactJson(artifact: AssuranceCapabilityArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** The generated TypeScript module: the same capabilities, inlined, in the shape
 *  the assurance runtime consumes (no filesystem, no JSON import). */
export function renderGeneratedTs(capabilities: DerivedCapability[]): string {
  const lines = [
    '// GENERATED FILE. Do not edit by hand; run bun run compat:assurance.',
    '//',
    '// The assurance engine\'s capabilities, DERIVED from the conformance graph by',
    '// packages/conformance/src/assurance-capabilities.ts (see that file\'s header for',
    '// the derivation rules). The assurance runtime consumes this module directly:',
    '// each record is structurally an AssuranceEngineCapability, and `reasons` carries',
    '// the graph evidence a probe cites when it abstains.',
    "import type { AssuranceCapabilityService, AssuranceCapabilityStatus } from './types.ts';",
    '',
    'export interface GeneratedAssuranceCapability {',
    '  id: string;',
    '  service: AssuranceCapabilityService;',
    '  status: AssuranceCapabilityStatus;',
    '  description: string;',
    '  /** The graph evidence that pinned the status: the dependencies whose verdict',
    '   *  equals it. A probe that abstains reports these. */',
    '  reasons: string[];',
    '}',
    '',
    'export const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[] = [',
  ];
  for (const capability of capabilities) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(capability.id)},`);
    lines.push(`    service: ${JSON.stringify(capability.service)},`);
    lines.push(`    status: ${JSON.stringify(capability.status)},`);
    lines.push(`    description: ${JSON.stringify(capability.description)},`);
    lines.push('    reasons: [');
    for (const reason of capability.reasons) lines.push(`      ${JSON.stringify(reason)},`);
    lines.push('    ],');
    lines.push('  },');
  }
  lines.push('];', '');
  return lines.join('\n');
}

function renderTable(capabilities: DerivedCapability[]): string {
  const width = Math.max(...capabilities.map((c) => c.id.length));
  return capabilities
    .map((c) => `${c.id.padEnd(width)}  ${c.status.padEnd(11)}  ${c.reasons[0] ?? ''}`)
    .join('\n');
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const capabilities = deriveAllCapabilities();
  const artifactJson = renderArtifactJson(buildArtifact(capabilities));
  const generatedTs = renderGeneratedTs(capabilities);

  if (args.has('--check')) {
    const drift: string[] = [];
    for (const [path, expected] of [
      [ARTIFACT_PATH, artifactJson],
      [GENERATED_TS_PATH, generatedTs],
    ] as const) {
      let actual = '';
      try {
        actual = readFileSync(path, 'utf8');
      } catch {
        drift.push(`${path}: missing`);
        continue;
      }
      if (actual !== expected) drift.push(`${path}: out of date`);
    }
    if (drift.length > 0) {
      console.error('Assurance capability artifact drift:');
      for (const item of drift) console.error(`  - ${item}`);
      console.error('Run: bun run compat:assurance');
      process.exit(1);
    }
    console.log(`assurance capabilities: ${capabilities.length} derived, artifact up to date`);
    return;
  }

  if (args.has('--write')) {
    writeFileSync(ARTIFACT_PATH, artifactJson);
    writeFileSync(GENERATED_TS_PATH, generatedTs);
    console.log(`Wrote ${ARTIFACT_PATH}\nWrote ${GENERATED_TS_PATH}`);
    return;
  }

  console.log(renderTable(capabilities));
}

if (import.meta.main) main();
