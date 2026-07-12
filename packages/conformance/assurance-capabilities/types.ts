/**
 * Types for the assurance-capability records and the derived artifact.
 *
 * An assurance capability is a claim about what the local rules simulator can
 * DECIDE — the unit an adversarial assurance probe consults before it treats a
 * verdict as evidence. A probe whose capability is not `supported` must abstain
 * (report an engine gap) rather than report a security conclusion.
 *
 * The records in this directory are AUTHORED: a human declares WHAT a
 * capability depends on. They carry no status. The status is DERIVED from the
 * conformance graph by `src/assurance-capabilities.ts` — the graph decides
 * WHETHER the claim holds. A record cannot assert `supported`; there is no
 * field to assert it in.
 *
 * One record per file, named `<capability-id>.ts` (e.g. `firestore.crud.ts`),
 * exporting `capability`. The filename IS the id — the record carries no id
 * field, matching the one-record-per-file convention `surfaces/`, `rigs/`, and
 * `exceptions/` already use. The loader injects the id.
 */

/** The services an assurance capability can belong to. Mirrors the assurance
 *  runtime's `AssuranceService | 'auth'` union. */
export type AssuranceCapabilityService = 'firestore' | 'rtdb' | 'storage' | 'auth';

/** The derived status. Mirrors the assurance runtime's
 *  `AssuranceEngineCapability['status']`. Never authored. */
export type AssuranceCapabilityStatus = 'supported' | 'qualified' | 'unsupported';

/**
 * A dependency on one rules-language construct (`rules-language/<engine>.json`).
 * The construct id is the join key across all three per-construct reports
 * (snapshot status, capability probe, coverage).
 */
export interface ConstructDependency {
  kind: 'construct';
  /** A construct id that must exist in the engine's language snapshot. */
  id: string;
}

/**
 * A dependency on one compatibility-registry row (`registry/*.ts`). Used where
 * the behavior a capability needs is an SDK or rules-engine BEHAVIOR the
 * registry already adjudicates against production (auth acquisition flows, the
 * rules-engine fidelity rows), not a language construct.
 */
export interface RegistryRowDependency {
  kind: 'registry-row';
  /** A row id that must exist in some registry, e.g. `auth#6`,
   *  `storage-rules#116`. */
  id: string;
}

/**
 * A declared dependency on a behavior the conformance graph does not model at
 * all: no language construct enumerates it and no registry row adjudicates it.
 * The graph therefore has NO evidence for it, and no-evidence is not support:
 * an unbacked dependency forces `unsupported`.
 *
 * This is how a capability whose defining behavior lives outside the graph
 * (atomic multi-write batches, transaction retries, listener re-evaluation,
 * resumable-upload state) reports honestly instead of borrowing the status of
 * whatever adjacent constructs it happens to touch.
 */
export interface UnbackedDependency {
  kind: 'unbacked';
  /** The behavior the capability needs, stated plainly. */
  behavior: string;
  /** Why the graph cannot back it. */
  reason: string;
}

export type CapabilityDependency =
  | ConstructDependency
  | RegistryRowDependency
  | UnbackedDependency;

/** One authored capability record: `<capability-id>.ts` exports this as
 *  `capability`. WHAT the capability needs — never whether it holds. */
export interface AssuranceCapabilityRecord {
  service: AssuranceCapabilityService;
  /** What the capability claims the engine can decide. Rendered verbatim into
   *  the generated artifact. */
  description: string;
  /** Everything the capability's verdict rests on. An empty list is illegal:
   *  a capability with no declared dependencies is an unfalsifiable claim. */
  dependencies: CapabilityDependency[];
}

/** The per-dependency verdict the derivation computes. Same lattice as the
 *  capability status: the capability's status is the WEAKEST verdict among its
 *  dependencies. */
export type DependencyVerdict = AssuranceCapabilityStatus;

/** What the simulator's capability probe did with a construct. `absent` means the
 *  probe report does not mention it at all. */
export type ProbeClassification = 'implemented' | 'unsupported' | 'error' | 'unprobeable' | 'absent';

/**
 * The evidence for a construct dependency: the FACTS the verdict is computed
 * from, each one a property of THIS construct.
 *
 * `productionVerified` is a BOOLEAN, never a count and never the scenario ids.
 * How MANY corpus scenarios happen to exercise a construct is a property of the
 * corpus, not of the construct: it moves whenever anyone captures a scenario
 * anywhere, so freezing it here would rewrite this record for a change that did
 * not touch this construct. The predicate is what the derivation reads, so the
 * predicate is what the record carries. A human who wants the scenarios reads
 * them from the coverage report at print time.
 */
export interface DerivedConstructDependency {
  kind: 'construct';
  id: string;
  verdict: DependencyVerdict;
  /** The construct's status in its engine's language snapshot. */
  snapshot: string;
  /** The local simulator's capability-probe classification. */
  probe: ProbeClassification;
  /** The shared predicate (`production-verification.ts`): does at least one
   *  evidence path compare this construct against production? */
  productionVerified: boolean;
  /** The rules-engine rows whose documented divergence covers this construct.
   *  Authored, construct-scoped, and causal: a row lands in this list only by
   *  naming the construct. */
  divergedBy: string[];
}

/** The evidence for a registry-row dependency: the row's own adjudicated state. */
export interface DerivedRegistryRowDependency {
  kind: 'registry-row';
  id: string;
  verdict: DependencyVerdict;
  /** The registry the row lives on, or `missing` if no registry declares it. */
  surface: string;
  /** The row's compatibility status, or `missing`. */
  status: string;
  /** Whether the surface IS a rules engine (decides what a `diverged-documented`
   *  row contaminates: the verdict machinery, or only the probe's setup). */
  rulesEngineSurface: boolean;
}

/** The evidence for an unbacked dependency: the authored declaration itself. The
 *  graph models nothing here, so there is nothing to look up. */
export interface DerivedUnbackedDependency {
  kind: 'unbacked';
  /** The behavior the capability needs. */
  id: string;
  verdict: DependencyVerdict;
  /** Why the graph cannot back it. */
  reason: string;
}

/** One dependency, with the graph facts that produced its verdict. */
export type DerivedDependency =
  | DerivedConstructDependency
  | DerivedRegistryRowDependency
  | DerivedUnbackedDependency;

/**
 * One capability as the graph computes it: the authored record's `service` and
 * `description`, a DERIVED `status`, and the facts behind every dependency.
 *
 * There is no `reasons` field. A reason is a SENTENCE, and a sentence is a
 * rendering of these facts — it belongs to whoever prints it, not to the
 * artifact. The dependencies that pinned the status are exactly
 * `dependencies.filter((d) => d.verdict === status)`; a reader derives that
 * rather than reading a frozen copy of it.
 */
export interface DerivedCapability {
  id: string;
  service: AssuranceCapabilityService;
  status: AssuranceCapabilityStatus;
  description: string;
  dependencies: DerivedDependency[];
}

/** The generated artifact: `assurance-capabilities/capabilities.json`. */
export interface AssuranceCapabilityArtifact {
  generatedNote: string;
  generator: string;
  /** The graph inputs the derivation read, for auditability. */
  inputs: string[];
  capabilities: DerivedCapability[];
}
