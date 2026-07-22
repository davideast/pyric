/**
 * Shared types for the rules-language snapshots (issue #185, step 1).
 *
 * A rules *language* snapshot is the denominator for the two per-engine
 * coverage axes the issue defines. Mirrors count exports; the rules engines
 * have no exports, so instead we enumerate every construct of each platform's
 * finite rules language and pin it as committed reference data.
 *
 * These snapshots are of the COMPUTED class: one file per engine
 * (`<engine>.json`), regenerated wholesale from the official Firebase rules
 * language references PLUS the repository's own ground truth (the Firestore
 * grammar + inlined stdlib, the Storage evaluator's bindings, the RTDB Ohm
 * grammar + its method set). They are NOT per-construct authored records.
 *
 * Where the official docs and the parser/evaluator disagree, the construct is
 * still listed, carrying a `note` describing the discrepancy — a divergence is
 * a finding, not a reason to omit.
 */

/** The three rules engines pyric mirrors. */
export type RulesEngine = 'firestore' | 'storage' | 'rtdb';

/**
 * The construct classes. Every snapshot record declares exactly one.
 *
 *   - `binding`   — a global / bound value read as a path, not called:
 *                   `request`, `resource`, `request.auth.uid`, RTDB `auth`,
 *                   `newData`, `root`, `now`, and path variables.
 *   - `function`  — a callable invoked bare or through a namespace:
 *                   `get(...)`, `exists(...)`, `math.abs(...)`,
 *                   `timestamp.date(...)`, the type-conversion builtins.
 *   - `method`    — a call that dispatches on a receiver value's type:
 *                   `<string>.matches(...)`, `<list>.hasAll(...)`,
 *                   RTDB `<snapshot>.child(...)`. Carries `receiverType`.
 *   - `operator`  — a syntactic operator: `&&`, `==`, `+`, ternary, `in`,
 *                   `is`, indexing, slicing.
 *   - `rule-kind` — a rule/declaration form: `allow read`, `.read`,
 *                   `.validate`, `match`, `function`, `rules_version`.
 *   - `semantic`  — a named language semantic that is not a single token:
 *                   hierarchical-match cascade, error absorption in `&&`/`||`,
 *                   the `get()` budget, RTDB read/write cascade.
 */
export type ConstructKind =
  | 'binding'
  | 'function'
  | 'method'
  | 'operator'
  | 'rule-kind'
  | 'semantic';

export const CONSTRUCT_KINDS: readonly ConstructKind[] = [
  'binding',
  'function',
  'method',
  'operator',
  'rule-kind',
  'semantic',
] as const;

/**
 * Per-construct probe status. Step 1 seeds every construct `unprobed`.
 * Step 5 (the credentialed production acceptance probe,
 * `rules-language-acceptance.ts`) advances firestore/storage constructs to:
 *   - `accepted`    — production's Rules Test API parsed/accepted a ruleset
 *                     exercising the construct.
 *   - `rejected`    — production rejected the ruleset (a parse/validation
 *                     error naming this construct); see `probeNote` for the
 *                     server's message. This is a finding: the snapshot
 *                     claimed the construct was real language surface, and
 *                     production disagrees.
 *   - `unprobeable` — no ruleset-acceptance probe can be generated for the
 *                     construct (the same semantic/meta constructs the
 *                     capability probe already marks unprobeable — module
 *                     resolution, resource-limit semantics, multi-node
 *                     relationships). Not a finding; a documented limit of
 *                     this probing method.
 * RTDB constructs stay `unprobed` — there is no Test API for RTDB rules
 * (issue #185 step 5 explicitly excludes the RTDB arm).
 */
export type ConstructStatus = 'unprobed' | 'accepted' | 'rejected' | 'unprobeable';

/** One enumerated construct of a rules language. */
export interface LanguageConstruct {
  /** Stable id, unique within the engine. Convention:
   *  `<engine>.<kind>[.<receiverType>].<name>`, e.g.
   *  `firestore.method.string.matches`, `rtdb.binding.newData`. Doubles as the
   *  join key the analyzer and the capability probe report against. */
  id: string;
  /** Canonical developer-facing names when the stable id tail is insufficient. */
  featureKeys?: string[];
  kind: ConstructKind;
  engine: RulesEngine;
  /** For `method` constructs: the value type the method dispatches on
   *  (`string`, `list`, `map`, `timestamp`, `snapshot`, …). Absent for other
   *  kinds. */
  receiverType?: string;
  /** Citation to the official language-reference section this construct comes
   *  from (a `firebase.google.com/docs/...` anchor, or a named grammar/spec
   *  section for the RTDB expression language). */
  reference: string;
  status: ConstructStatus;
  /** Present only when the official reference and the repo's own
   *  parser/evaluator disagree about the construct: describes the divergence.
   *  A populated `note` is a documented doc-vs-parser finding. */
  note?: string;
  /** Present for `status: 'rejected'` (the production Rules Test API's own
   *  rejection message, verbatim) and `status: 'unprobeable'` (why no
   *  ruleset-acceptance probe could be generated for this construct).
   *  Distinct from `note`: `note` records a doc-vs-parser divergence found by
   *  static inspection; `probeNote` records what the LIVE production
   *  acceptance probe (issue #185 step 5) observed. A construct can carry
   *  both. */
  probeNote?: string;
  /** SHA-256 identity of the exact Firestore Rules Test microprobe whose live
   *  result produced `status`/`probeNote`. Acceptance credit is withheld when
   *  this no longer matches the canonical probe generator. */
  probeDigest?: { algorithm: 'sha256'; value: string };
  /** Whether production's evaluated verdict matched the canonical probe's
   *  expected verdict. Required for accepted constructs to receive credit. */
  probeEvaluationAgreement?: boolean;
  /** Present when this construct can never be credited by the static AST
   *  analyzer (rules-language-analyzer.ts, issue #185 step 2): it is a
   *  genuine language semantic with no expression-level AST representation
   *  to walk — ambient engine behavior (or a runtime/scenario-outcome fact),
   *  not something a ruleset's source text "contains" at some walkable node.
   *  Distinct from `note` (a doc-vs-parser divergence) and `probeNote` (a
   *  live production acceptance-probe finding): this documents why the
   *  analyzer's coverage report will show this construct with a permanently
   *  empty `exercisedBy`/`verifiedBy` — a documented limit of the analysis
   *  method, not an unaddressed gap. */
  unattributable?: string;
}

/** A whole-engine snapshot: the file shape of `<engine>.json`. */
export interface LanguageSnapshot {
  engine: RulesEngine;
  /** The engine version the enumeration is pinned to (informational). */
  version: string;
  /** Provenance: the references and repo ground truth the snapshot was seeded
   *  from. Kept in the file so a regeneration is auditable. */
  sources: string[];
  constructs: LanguageConstruct[];
}
