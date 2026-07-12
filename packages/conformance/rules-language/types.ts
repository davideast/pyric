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
  /** Present when this construct is EXCLUDED from the coverage denominator.
   *  See {@link ConstructExclusion}: an exclusion names a reason CLASS with a
   *  predicate the loader enforces, never free prose. Distinct from `note` (a
   *  doc-vs-parser divergence) and `probeNote` (a live production
   *  acceptance-probe finding). */
  excluded?: ConstructExclusion;
}

/**
 * The reason classes a construct may be excluded from the coverage denominator.
 *
 * An exclusion REMOVES a construct from the denominator of the published
 * verified-coverage ratio, so every exclusion raises the number without anything
 * getting better. That makes the exclusion field the softest place in the trust
 * chain: while it took free prose, "this one is hard to attribute" and "this one
 * is not a coverage gap" were the same keystroke, and the only thing standing
 * between an inconvenient construct and a 100% ratio was the author's honesty.
 *
 * A reason class is not prose. Each one carries a PREDICATE the loader checks
 * against the construct's own snapshot record (see load.ts), and an exclusion
 * whose predicate does not hold is a hard validation failure — the construct
 * stays in the denominator as the gap it is.
 *
 *   `no-ast-node`        the construct is a language SEMANTIC with no
 *                        expression-level token: ambient engine behavior, not
 *                        something a ruleset's source text contains at a
 *                        walkable node, so the static analyzer has nothing to
 *                        credit it from. Predicate: `kind` must be `semantic`.
 *                        An operator, binding, method or function IS a token —
 *                        it can always be found in an AST, so it can never take
 *                        this class.
 *
 *   `not-authorization`  the construct yields no ALLOW/DENY verdict — it is a
 *                        declaration-level DIRECTIVE the engine reads for some
 *                        other purpose (RTDB's `.indexOn` tells the database how
 *                        to index; it never participates in an authorization
 *                        decision). Predicate: `kind` must be `rule-kind`, and
 *                        the reason must state why the construct cannot appear
 *                        in an authorization decision. Anything that can appear
 *                        INSIDE a rule expression (operator, binding, method,
 *                        function) feeds the value that IS the verdict, and a
 *                        `semantic` is engine behavior in the verdict path;
 *                        neither can claim this class.
 *
 *   `production-rejects` production refuses to compile the construct: the
 *                        snapshot enumerated it as language surface and the
 *                        production Rules Test API disagreed, so no ruleset that
 *                        uses it can ever be deployed and no scenario can ever
 *                        exercise it. Predicate: `status` must be `rejected` AND
 *                        the construct must carry a `probeNote` with
 *                        production's verbatim rejection message. A construct
 *                        production ACCEPTS is an ordinary, closeable coverage
 *                        gap and cannot take this class.
 */
export type ExclusionClass = 'no-ast-node' | 'not-authorization' | 'production-rejects';

export const EXCLUSION_CLASSES: readonly ExclusionClass[] = [
  'no-ast-node',
  'not-authorization',
  'production-rejects',
] as const;

/** One construct's exclusion from the coverage denominator. */
export interface ConstructExclusion {
  /** The reason class. The loader enforces this class's predicate against the
   *  construct's own record; an exclusion that fails its predicate is fatal. */
  class: ExclusionClass;
  /** Why this construct satisfies the class predicate. Prose for the reader —
   *  it explains the exclusion, it does not authorize it; the class does that,
   *  and only if its predicate holds. */
  reason: string;
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
