/**
 * Shared corpus types for the RTDB rules conformance chain.
 *
 * Mirrors the Firestore/Storage corpora (../firestore/types.ts,
 * ../storage/types.ts) for the `realtime-database` surface. Unlike those two,
 * RTDB has NO server-side rules test API: its production truth is captured by
 * DEPLOYING a real ruleset, executing ops against the live database, observing
 * allow/deny, then restoring the prior ruleset. Every scenario here is a
 * decomposition of one ruleset from the frozen
 * `rtdb-simulator-vs-prod-agreement` agreement observation, and each case's
 * `expectation` is the production verdict that observation recorded — never the
 * simulator's, never invented.
 *
 * An `RtdbScenario` is a self-contained conformance unit: one ruleset SUBTREE plus
 * the ops that exercise it. `rules` is the JSON string of the subtree exactly as
 * the agreement probe deployed it; the subtree mounts under the scenario id (the
 * mount key doubles as the observation stem, `rules-rtdb-<id>.json`). Both
 * consumers — the capture runner (src/run-rules-rtdb.ts) and the in-process
 * replay suite (packages/pyric/test/rules/rtdb/rules-conformance.test.ts) — mount
 * the subtree under the scenario id and run the same ops, so a scenario hands off to
 * either the live database or the in-process `SimulateHandler` without
 * translation.
 */

/** A single (rule, op) tuple. `operation`/`opPath`/`authPresent`/`newData`/
 *  `mockData` reproduce the agreement probe's op verbatim; `expectation` is the
 *  production verdict frozen for that op. `opPath` is relative to the scenario's
 *  mount key (e.g. `/value`) and may carry the literal token `<UID>`, which the
 *  runner/replay substitute with the signed-in uid. */
export interface RtdbTestCase {
  /** Unique within the scenario; the verdict-table key in observations. Carried
   *  over from the agreement probe's op label. */
  description: string;
  /** The PRODUCTION verdict recorded in the agreement observation for this op.
   *  Source of truth for the replay assertion. */
  expectation: 'ALLOW' | 'DENY';
  /** `write` is a `set()` of `newData` at `opPath`. `update` is an `update()` at
   *  `opPath` whose `newData` is the patch: an object keyed by paths relative to
   *  `opPath`, each one a location the update writes. `query` is a `get()` of
   *  a query at `opPath` built from `query`. */
  operation: 'read' | 'write' | 'update' | 'query';
  /** Path relative to the scenario's mount key. May contain the `<UID>` token. */
  opPath: string;
  authPresent: boolean;
  /** Custom claims the signed-in user's ID token carries. Present only with
   *  `authPresent: true`: capture signs in with a custom token minted for
   *  these claims, so `auth.token.firebase.sign_in_provider` is `custom`.
   *  Absent, a signed-in case is an anonymous sign-in. */
  claims?: Record<string, unknown>;
  /** The query a `query` case reads with. Required for `query` cases and
   *  refused on every other operation. */
  query?: RtdbCaseQuery;
  /** The value written (write ops) or the patch (update ops). `<UID>` tokens
   *  inside are substituted. */
  newData?: unknown;
  /** The pre-existing value at the op path (governs `data.exists()` etc.). For
   *  the simulator this becomes the mock snapshot at the op path; for prod the
   *  runner seeds it via the admin SDK. */
  mockData?: unknown;
  /** Pre-existing values at paths relative to the scenario mount. Capture writes
   *  them through the admin adapter; local replay projects the same paths into
   *  the simulator root before the operation. */
  seed?: Record<string, unknown>;
  /** Set ONLY when the frozen agreement observation carried no recoverable
   *  production verdict for this tuple (prodAllowed was null). Such a case is
   *  RECORDED but EXCLUDED from replay assertions until a fresh capture lands.
   *  No current case sets this — every agreement-observation tuple has a
   *  recorded verdict. */
  pendingCapture?: boolean;
}

/** The query constraints a `query` case applies, in the shape the rules
 *  `query` variable exposes. At most one `orderBy*` field is set. */
export interface RtdbCaseQuery {
  orderByChild?: string;
  orderByKey?: true;
  orderByValue?: true;
  orderByPriority?: true;
  equalTo?: string | number | boolean | null;
  startAt?: string | number | boolean | null;
  endAt?: string | number | boolean | null;
  limitToFirst?: number;
  limitToLast?: number;
}

/**
 * An RTDB rules conformance scenario. Same provenance fields as the Firestore
 * {@link import('../firestore/types.ts').Scenario} (so the corpora stay legible
 * side by side), plus `provenance` — the frozen seed observation this scenario was
 * decomposed from — and RTDB-shaped cases.
 */
export interface RtdbScenario {
  /** Stable identifier. Doubles as the subtree mount key AND the observation
   *  filename stem: `rules-rtdb-<id>.json`. Must be unique across all three
   *  corpora (firestore, storage, rtdb). */
  id: string;
  /** Failure-mode / ledger tag. */
  fm: string;
  /** One line: why this scenario should reveal something. */
  rationale: string;
  /** The seed evidence this scenario was decomposed from — cites the frozen
   *  agreement observation by name so provenance survives in the record. */
  provenance: string;
  /** JSON string of the ruleset SUBTREE under test, exactly as the agreement
   *  probe deployed it. Mounts under the scenario id at capture/replay time. */
  rules: string;
  /** The ops to run against `rules`. Each `description` is unique within the
   *  scenario and is the verdict-table key in observations. */
  cases: RtdbTestCase[];
}

/**
 * The authored shape for one file in rules-corpus/rtdb/. The filename IS the
 * scenario id, so the record carries no `id` field — the loader (./load.ts) injects
 * it from the filename.
 */
export type RtdbScenarioRecord = Omit<RtdbScenario, 'id'>;

/**
 * One ruleset production's deploy endpoint is asked to accept. `rules` is the
 * JSON string of the subtree, mounted under the scenario id exactly as an
 * operation scenario's subtree is. `construct` names the
 * `rules-language/rtdb.json` construct the ruleset isolates.
 */
export interface RtdbDeployCase {
  /** Unique within the scenario; the key in the observation's behavior table. */
  description: string;
  /** The construct id in `rules-language/rtdb.json` this ruleset isolates. */
  construct: string;
  /** JSON string of the subtree under test. */
  rules: string;
  /** Production's recorded answer: `ACCEPTED`, or `REJECTED` with the
   *  deploy endpoint's error text verbatim (the run-scoped mount key replaced
   *  by `<mount>`). */
  expectation: RtdbDeployVerdict;
}

export type RtdbDeployVerdict =
  | { verdict: 'ACCEPTED' }
  | { verdict: 'REJECTED'; error: string };

/**
 * A deploy-acceptance scenario: rulesets sent to production's rules endpoint
 * as a dry run (`PUT /.settings/rules.json?dryRun=true`, the validation step
 * `firebase deploy` runs before it deploys). Production either accepts the
 * ruleset or rejects it with an error text, and nothing is deployed either way.
 */
export interface RtdbDeployScenario {
  id: string;
  fm: string;
  rationale: string;
  provenance: string;
  deployCases: RtdbDeployCase[];
}

export type RtdbDeployScenarioRecord = Omit<RtdbDeployScenario, 'id'>;
