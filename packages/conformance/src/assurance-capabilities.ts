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
 *                  production-verified AND no divergence covers it.
 *
 *   PRODUCTION-VERIFIED is not defined here. It is defined once, in
 *   `production-verification.ts`, and this generator and the coverage analyzer
 *   both call that predicate — the two numbers cannot drift apart. In short: a
 *   construct is verified either SYNTACTICALLY (a production-captured corpus
 *   scenario's ruleset AST contains it — `verifiedBy` in the coverage report) or
 *   BEHAVIORALLY (a `conforms` + `oracle-backed` rules-engine row lists it in
 *   `constructs`). The behavioral path exists because the analyzer detects
 *   constructs in SOURCE, and an engine semantic (the RTDB cascades, error
 *   absorption) has no source token to detect — only a verdict. See that
 *   module's header for the honesty line on what a row may and may not credit.
 *   An un-annotated row supplies no verification, so a missing annotation can
 *   only hold a capability DOWN, never lift it.
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
 *   `assurance-capabilities/capabilities.json` — the artifact, with the facts
 *   behind every dependency's verdict.
 *   `assurance-capabilities/generated.ts` — the same capabilities as a typed,
 *   inlined const (`ASSURANCE_ENGINE_CAPABILITIES`), the shape the assurance
 *   runtime consumes with no filesystem access, plus the read-time renderer
 *   (`capabilityReasons`) that turns those facts into sentences.
 *
 * ── THE STANDING CONSTRAINT: DERIVED FACTS, NEVER DERIVED PROSE ─────────────
 *
 * A generated record may carry ONLY facts whose value is determined by the thing
 * the record is about. Never a count, a total, a percentage, a rank, or any
 * other whole-population aggregate — and never a prose sentence containing one.
 *
 * WHY (this artifact learned it the hard way): each construct's evidence used to
 * read "production-verified by 19 captured scenario(s)". That 19 is a fact about
 * the CORPUS, not about the construct. Capture one scenario anywhere and dozens
 * of unrelated capability records rewrite: the diff then lies about causality (a
 * reviewer sees `firestore.operator.and` move and asks what happened to AND —
 * nothing did), a genuine `qualified -> supported` event drowns in the noise, and
 * `compat:assurance:check` fails on branches that never touched assurance, which
 * turns regeneration into a reflex and lets a stale artifact through unexamined.
 * A derived artifact that encodes a global fact churns globally.
 *
 * THE RULE, mechanically: a record's bytes may change only when a verdict in it
 * changes. If you want to add a field, ask what else could move it. "Someone
 * captured an unrelated scenario" is a NO. `assurance-capabilities.test.ts`
 * holds this line: it perturbs the corpus counts without changing any verdict and
 * asserts both artifacts are byte-identical. A count belongs in the printed
 * report (`bun run compat:assurance`), which reads the corpus fresh and may say
 * whatever a human finds useful — stdout is not a durable artifact.
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
  deriveConformanceGraph,
  describeProductionFact,
  indexConstructScopes,
} from './production-verification.ts';
import { loadAllSnapshots } from '../rules-language/load.ts';
import { loadAssuranceCapabilityRecords, type LoadedCapability } from '../assurance-capabilities/load.ts';
import type {
  AssuranceCapabilityArtifact,
  AssuranceCapabilityStatus,
  DerivedCapability,
  DerivedConstructDependency,
  DerivedDependency,
  DerivedRegistryRowDependency,
  DependencyVerdict,
} from '../assurance-capabilities/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_DIR = join(HERE, '..', 'assurance-capabilities');
const LANGUAGE_DIR = join(HERE, '..', 'rules-language');
export const ARTIFACT_PATH = join(CAPABILITY_DIR, 'capabilities.json');
export const GENERATED_TS_PATH = join(CAPABILITY_DIR, 'generated.ts');
/** The assurance runtime's copy. `@pyric/cli` does not depend on this private
 *  package, so the generator writes the capabilities into it directly. Checked
 *  alongside the other outputs: drift here fails CI too. */
export const RUNTIME_TS_PATH = join(
  HERE,
  '..',
  '..',
  'pyric-tools',
  'src',
  'assurance',
  'generated-capabilities.ts',
);

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
   *  cover it (the BEHAVIORAL production-verification path — see
   *  production-verification.ts) */
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
  const { provingRows, divergingRows } = indexConstructScopes(surfaceRegistries);

  return {
    snapshotStatus,
    probeClass,
    verifiedBy,
    rows,
    divergedBy: divergingRows,
    oracleProvedBy: provingRows,
  };
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

/**
 * The facts about one construct. Each field is a property of THIS construct: its
 * snapshot status, what the probe did with it, whether production verified it,
 * and which divergences name it. Nothing here can move because of a change
 * elsewhere in the corpus — see the standing constraint in this file's header.
 */
function deriveConstruct(graph: ConformanceGraph, id: string): DerivedConstructDependency {
  const snapshot = graph.snapshotStatus.get(id) ?? 'missing';
  const probe = graph.probeClass.get(id) ?? 'absent';
  const divergedBy = graph.divergedBy.get(id) ?? [];
  const verdicts: DependencyVerdict[] = [];

  if (snapshot === 'rejected') {
    verdicts.push('unsupported');
  } else if (snapshot === 'unprobed' || snapshot === 'unprobeable') {
    verdicts.push('qualified');
  } else {
    verdicts.push('supported');
  }

  if (probe === 'unsupported' || probe === 'error' || probe === 'absent') {
    verdicts.push('unsupported');
  } else if (probe === 'unprobeable') {
    verdicts.push('qualified');
  } else {
    verdicts.push('supported');
  }

  // The SHARED predicate (production-verification.ts): the same question the
  // coverage report's `verifiedConstructs` numerator asks, answered once. The
  // artifact records the ANSWER (a boolean), never the evidence population that
  // produced it.
  const productionFact = productionFactOf(graph, id);
  const productionVerified = productionFact.verdict === 'verified';
  verdicts.push(productionVerified ? 'supported' : 'qualified');

  if (divergedBy.length > 0) verdicts.push('unsupported');

  return { kind: 'construct', id, verdict: weakest(verdicts), snapshot, probe, productionVerified, divergedBy };
}

function productionFactOf(graph: ConformanceGraph, id: string) {
  return deriveConformanceGraph({
    scenariosByConstruct: graph.verifiedBy,
    provingRowsByConstruct: graph.oracleProvedBy,
    divergingRowsByConstruct: graph.divergedBy,
  }).factOf(id);
}

function deriveRow(graph: ConformanceGraph, id: string): DerivedRegistryRowDependency {
  const row = graph.rows.get(id);
  if (!row) {
    return {
      kind: 'registry-row',
      id,
      verdict: 'unsupported',
      surface: 'missing',
      status: 'missing',
      rulesEngineSurface: false,
    };
  }
  const rulesEngineSurface = RULES_ENGINE_SURFACES.has(row.surface);
  let verdict: DependencyVerdict;
  if (row.status === 'bug' || row.status === 'unsupported') {
    verdict = 'unsupported';
  } else if (row.status === 'diverged-documented') {
    // A divergence in the verdict machinery itself is disqualifying; a divergence
    // in an SDK surface only qualifies the probe's setup.
    verdict = rulesEngineSurface ? 'unsupported' : 'qualified';
  } else if (row.status === 'unverified') {
    verdict = 'qualified';
  } else {
    verdict = 'supported';
  }
  return { kind: 'registry-row', id, verdict, surface: row.surface, status: row.status, rulesEngineSurface };
}

/** Derive one capability from the graph. */
export function deriveCapability(graph: ConformanceGraph, record: LoadedCapability): DerivedCapability {
  const dependencies: DerivedDependency[] = record.dependencies.map((dep) => {
    if (dep.kind === 'construct') return deriveConstruct(graph, dep.id);
    if (dep.kind === 'registry-row') return deriveRow(graph, dep.id);
    return { kind: 'unbacked', id: dep.behavior, verdict: 'unsupported', reason: dep.reason };
  });

  const status = weakest(dependencies.map((dep) => dep.verdict));
  return { id: record.id, service: record.service, status, description: record.description, dependencies };
}

/** The dependencies that pinned a capability's status: derived on read, never
 *  frozen (a frozen copy is a second thing to keep in sync). */
export function pinningDependencies(capability: DerivedCapability): DerivedDependency[] {
  return capability.dependencies.filter((dep) => dep.verdict === capability.status);
}

/** Derive every capability. Throws on any validation problem. */
export function deriveAllCapabilities(graph: ConformanceGraph = loadConformanceGraph()): DerivedCapability[] {
  const records = loadAssuranceCapabilityRecords();
  const problems = validationProblems(graph, records);
  if (problems.length > 0) {
    throw new Error(`assurance-capability graph is not resolvable:\n  - ${problems.join('\n  - ')}`);
  }
  return records.map((record) => deriveCapability(graph, record));
}

const GENERATED_NOTE =
  'GENERATED from the conformance graph by packages/conformance/src/assurance-capabilities.ts. Do not edit by hand; run bun run compat:assurance. This is the assurance CATALOG the runtime hands an agent through listAssuranceCapabilities: what the engine can verify, grouped under described capabilities. Each capability declares its description and grouped graph nodes in packages/conformance/assurance-capabilities/<id>.ts; the status here is DERIVED, never asserted, rolled up from the nodes it groups. A probe does not cite a capability: it names the graph nodes it needs directly, and a node the graph derives as not "supported" makes the probe abstain (engine-gap) rather than report a security conclusion. Every dependency carries the FACTS behind its verdict and no count, total, or other whole-population aggregate: an aggregate would move this file whenever anything anywhere in the corpus moved, so these records change only when a verdict changes. Sentences (with counts, if a human wants them) are rendered on read: bun run compat:assurance.';

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

/**
 * The read-time renderer, emitted INTO each generated module.
 *
 * It is emitted rather than imported because the consumer that needs it most —
 * the assurance runtime in `@pyric/cli` — cannot import from this package
 * (`conformance` is private and is not one of its dependencies). Emitting it
 * keeps one definition (this constant) and gives every generated copy the same
 * wording, whatever package it lands in. It depends on nothing but the record's
 * own fields, so it is paste-able into a self-contained copy unchanged.
 *
 * This is where the sentences live now. The artifact carries facts; a reader who
 * wants prose calls `capabilityReasons` at read time.
 */
const EMITTED_RENDERER = [
  '/** One dependency, as a sentence. The facts are the record; this is a view of',
  ' *  them, built on read. */',
  'export function describeCapabilityDependency(dependency: GeneratedCapabilityDependency): string {',
  '  if (dependency.kind === "construct") {',
  '    const facts = [',
  '      `snapshot status "${dependency.snapshot}"`,',
  '      `capability probe "${dependency.probe}"`,',
  '      dependency.productionVerified',
  '        ? "production-verified against captured production behavior"',
  '        : "no production-captured scenario and no conforming oracle-backed row verifies it",',
  '    ];',
  '    if (dependency.divergedBy.length > 0) {',
  '      facts.push(`covered by rules-engine divergence ${dependency.divergedBy.join(", ")}`);',
  '    }',
  '    return `${dependency.id}: ${facts.join("; ")}`;',
  '  }',
  '  if (dependency.kind === "registry-row") {',
  '    const facts = [`registry row ${dependency.id} (${dependency.surface}) status "${dependency.status}"`];',
  '    if (dependency.status === "diverged-documented") {',
  '      facts.push(',
  '        dependency.rulesEngineSurface',
  '          ? "divergence is in the rules engine itself: the verdict machinery is known wrong here"',
  '          : "divergence is in an SDK surface: the verdict machinery is sound, the probe setup is not production-identical",',
  '      );',
  '    }',
  '    return `${dependency.id}: ${facts.join("; ")}`;',
  '  }',
  '  return `${dependency.id}: the conformance graph does not model this behavior: ${dependency.reason}`;',
  '}',
  '',
  '/** The reasons a probe cites when it abstains: the dependencies whose verdict',
  ' *  pinned the capability\'s status, each rendered as a sentence. */',
  'export function capabilityReasons(capability: GeneratedAssuranceCapability): string[] {',
  '  return capability.dependencies',
  '    .filter((dependency) => dependency.verdict === capability.status)',
  '    .map(describeCapabilityDependency);',
  '}',
];

/**
 * The one definition of the capability-literal format. Emits each capability as
 * an object literal carrying the structured `dependencies` FACTS (never a
 * rendered sentence, never a count). Both generated copies — the conformance
 * module and the self-contained @pyric/cli module — render their literals here,
 * so the two cannot drift.
 */
function renderCapabilityLiterals(capabilities: DerivedCapability[]): string[] {
  const lines: string[] = [];
  for (const capability of capabilities) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(capability.id)},`);
    lines.push(`    service: ${JSON.stringify(capability.service)},`);
    lines.push(`    status: ${JSON.stringify(capability.status)},`);
    lines.push(`    description: ${JSON.stringify(capability.description)},`);
    lines.push('    dependencies: [');
    for (const dependency of capability.dependencies) {
      lines.push(`      ${JSON.stringify(dependency)},`);
    }
    lines.push('    ],');
    lines.push('  },');
  }
  return lines;
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
    '// each record is structurally an AssuranceEngineCapability.',
    '//',
    '// Each dependency carries the FACTS behind its verdict, never a sentence and',
    '// never a count: a count is a property of the corpus, so freezing one here would',
    '// rewrite unrelated records every time anyone captured a scenario. A probe that',
    '// abstains renders its reasons on read with `capabilityReasons(capability)`.',
    "import type { AssuranceCapabilityService, AssuranceCapabilityStatus } from './types.ts';",
    '',
    'export type CapabilityVerdict = AssuranceCapabilityStatus;',
    '',
    'export interface GeneratedConstructDependency {',
    "  kind: 'construct';",
    '  /** The rules-language construct id. */',
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  /** The construct\'s status in the production language snapshot. */',
    '  snapshot: string;',
    '  /** What the local simulator\'s capability probe did with it. */',
    "  probe: 'implemented' | 'unsupported' | 'error' | 'unprobeable' | 'absent';",
    '  /** Whether any evidence path compares it against production. A BOOLEAN: how',
    '   *  many scenarios do so is a fact about the corpus, not about this construct. */',
    '  productionVerified: boolean;',
    '  /** Rules-engine rows whose documented divergence names this construct. */',
    '  divergedBy: string[];',
    '}',
    '',
    'export interface GeneratedRegistryRowDependency {',
    "  kind: 'registry-row';",
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  surface: string;',
    '  status: string;',
    '  rulesEngineSurface: boolean;',
    '}',
    '',
    'export interface GeneratedUnbackedDependency {',
    "  kind: 'unbacked';",
    '  /** The behavior the capability needs. */',
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  /** Why the graph cannot back it. */',
    '  reason: string;',
    '}',
    '',
    'export type GeneratedCapabilityDependency =',
    '  | GeneratedConstructDependency',
    '  | GeneratedRegistryRowDependency',
    '  | GeneratedUnbackedDependency;',
    '',
    'export interface GeneratedAssuranceCapability {',
    '  id: string;',
    '  service: AssuranceCapabilityService;',
    '  status: AssuranceCapabilityStatus;',
    '  description: string;',
    '  /** Everything the status rests on. The ones that pinned it are the ones whose',
    '   *  verdict equals the status; `capabilityReasons` selects and renders them. */',
    '  dependencies: GeneratedCapabilityDependency[];',
    '}',
    '',
    'export const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[] = [',
    ...renderCapabilityLiterals(capabilities),
    '];',
    '',
    ...EMITTED_RENDERER,
    '',
  ];
  return lines.join('\n');
}

/**
 * The same capabilities, emitted a second time into the assurance runtime
 * (`@pyric/cli`).
 *
 * The dependency runs one way — `@pyric/cli` does not depend on this private
 * conformance package — so the runtime cannot import the module above. Instead
 * the generator writes a self-contained copy it CAN import: no imports at all,
 * the service and status unions inlined. Both outputs are checked by
 * `--check`, so a status that drifts in either one fails CI. The runtime's
 * capability statuses therefore remain underivable by hand: there is no file a
 * human may edit to assert one.
 */
export function renderRuntimeTs(capabilities: DerivedCapability[]): string {
  const lines = [
    '// GENERATED FILE. Do not edit by hand; run bun run compat:assurance.',
    '//',
    '// The assurance engine\'s capabilities, DERIVED from the conformance graph by',
    '// packages/conformance/src/assurance-capabilities.ts (see that file\'s header for',
    '// the derivation rules). This is the assurance runtime\'s copy: the conformance',
    '// package is private and is NOT a dependency of @pyric/cli, so the generator',
    '// emits this self-contained module here rather than have the runtime import it.',
    '//',
    '// A capability status is never authorable. It is derived from the graph, and',
    '// `bun run compat:assurance:check` fails if this file drifts from the graph.',
    '//',
    '// Each dependency carries the FACTS behind its verdict, never a sentence and',
    '// never a count. A probe that abstains renders its reasons on read with',
    '// `capabilityReasons(capability)`; the renderer is emitted below so this',
    '// self-contained copy needs no import to produce the abstention prose.',
    '',
    "export type AssuranceCapabilityService = 'firestore' | 'rtdb' | 'storage' | 'auth';",
    "export type AssuranceCapabilityStatus = 'supported' | 'qualified' | 'unsupported';",
    '',
    'export type CapabilityVerdict = AssuranceCapabilityStatus;',
    '',
    'export interface GeneratedConstructDependency {',
    "  kind: 'construct';",
    '  /** The rules-language construct id. */',
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  /** The construct\'s status in the production language snapshot. */',
    '  snapshot: string;',
    '  /** What the local simulator\'s capability probe did with it. */',
    "  probe: 'implemented' | 'unsupported' | 'error' | 'unprobeable' | 'absent';",
    '  /** Whether any evidence path compares it against production. A BOOLEAN: how',
    '   *  many scenarios do so is a fact about the corpus, not about this construct. */',
    '  productionVerified: boolean;',
    '  /** Rules-engine rows whose documented divergence names this construct. */',
    '  divergedBy: string[];',
    '}',
    '',
    'export interface GeneratedRegistryRowDependency {',
    "  kind: 'registry-row';",
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  surface: string;',
    '  status: string;',
    '  rulesEngineSurface: boolean;',
    '}',
    '',
    'export interface GeneratedUnbackedDependency {',
    "  kind: 'unbacked';",
    '  /** The behavior the capability needs. */',
    '  id: string;',
    '  verdict: CapabilityVerdict;',
    '  /** Why the graph cannot back it. */',
    '  reason: string;',
    '}',
    '',
    'export type GeneratedCapabilityDependency =',
    '  | GeneratedConstructDependency',
    '  | GeneratedRegistryRowDependency',
    '  | GeneratedUnbackedDependency;',
    '',
    'export interface GeneratedAssuranceCapability {',
    '  id: string;',
    '  service: AssuranceCapabilityService;',
    '  status: AssuranceCapabilityStatus;',
    '  description: string;',
    '  /** Everything the status rests on. The ones that pinned it are the ones whose',
    '   *  verdict equals the status; `capabilityReasons` selects and renders them. */',
    '  dependencies: GeneratedCapabilityDependency[];',
    '}',
    '',
    'export const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[] = [',
    ...renderCapabilityLiterals(capabilities),
    '];',
    '',
    ...EMITTED_RENDERER,
    '',
  ];
  return lines.join('\n');
}

/**
 * The printed report. This is READ TIME: the graph is open, so the sentences may
 * cite anything a human finds useful — including the scenario COUNT that must
 * never be frozen into an artifact. Nothing downstream parses stdout.
 */
function renderTable(graph: ConformanceGraph, capabilities: DerivedCapability[]): string {
  const width = Math.max(...capabilities.map((c) => c.id.length));
  return capabilities
    .map((capability) => {
      const reason = pinningDependencies(capability).map((dep) => describeForReport(graph, dep))[0] ?? '';
      return `${capability.id.padEnd(width)}  ${capability.status.padEnd(11)}  ${reason}`;
    })
    .join('\n');
}

/**
 * A dependency as a sentence for the REPORT. The generated module carries its own
 * renderer (`EMITTED_RENDERER`) for consumers that only have the record; this one
 * exists separately because it can still see the graph, and it says more with it:
 * the construct's production evidence is spelled out (how many scenarios, which
 * rows) rather than collapsed to the boolean the artifact carries. That extra
 * detail is exactly what may not be frozen, which is why it lives only here.
 */
function describeForReport(graph: ConformanceGraph, dependency: DerivedDependency): string {
  if (dependency.kind === 'unbacked') {
    return `${dependency.id}: the conformance graph does not model this behavior: ${dependency.reason}`;
  }
  if (dependency.kind === 'registry-row') {
    const facts = [`registry row ${dependency.id} (${dependency.surface}) status "${dependency.status}"`];
    if (dependency.status === 'diverged-documented') {
      facts.push(
        dependency.rulesEngineSurface
          ? 'divergence is in the rules engine itself: the verdict machinery is known wrong here'
          : 'divergence is in an SDK surface: the verdict machinery is sound, the probe setup is not production-identical',
      );
    }
    return `${dependency.id}: ${facts.join('; ')}`;
  }
  const facts = [
    `snapshot status "${dependency.snapshot}"`,
    `capability probe "${dependency.probe}"`,
    describeProductionFact(productionFactOf(graph, dependency.id)),
  ];
  return `${dependency.id}: ${facts.join('; ')}`;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const graph = loadConformanceGraph();
  const capabilities = deriveAllCapabilities(graph);
  const artifactJson = renderArtifactJson(buildArtifact(capabilities));
  const generatedTs = renderGeneratedTs(capabilities);
  const runtimeTs = renderRuntimeTs(capabilities);

  if (args.has('--check')) {
    const drift: string[] = [];
    for (const [path, expected] of [
      [ARTIFACT_PATH, artifactJson],
      [GENERATED_TS_PATH, generatedTs],
      [RUNTIME_TS_PATH, runtimeTs],
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
    writeFileSync(RUNTIME_TS_PATH, runtimeTs);
    console.log(`Wrote ${ARTIFACT_PATH}\nWrote ${GENERATED_TS_PATH}\nWrote ${RUNTIME_TS_PATH}`);
    return;
  }

  console.log(renderTable(graph, capabilities));
}

if (import.meta.main) main();
