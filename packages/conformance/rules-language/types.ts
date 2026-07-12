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

/** Per-construct probe status. Step 1 seeds every construct `unprobed`; later
 *  phases (the credentialed acceptance probes, issue #185 step 5) advance it. */
export type ConstructStatus = 'unprobed' | 'accepted' | 'rejected';

/** One enumerated construct of a rules language. */
export interface LanguageConstruct {
  /** Stable id, unique within the engine. Convention:
   *  `<engine>.<kind>[.<receiverType>].<name>`, e.g.
   *  `firestore.method.string.matches`, `rtdb.binding.newData`. Doubles as the
   *  join key the analyzer and the capability probe report against. */
  id: string;
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
