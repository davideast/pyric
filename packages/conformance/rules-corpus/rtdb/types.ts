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
 * replay suite (packages/pyric/test/database/rules-conformance.test.ts) — mount
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
  operation: 'read' | 'write';
  /** Path relative to the scenario's mount key. May contain the `<UID>` token. */
  opPath: string;
  authPresent: boolean;
  /** The value written (write ops). `<UID>` tokens inside are substituted. */
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
