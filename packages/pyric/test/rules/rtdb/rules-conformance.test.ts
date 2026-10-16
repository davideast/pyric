/**
 * Oracle conformance — RTDB rules (in-process simulator vs frozen production).
 *
 * The RTDB counterpart of test/rules/oracle-conformance.test.ts (Firestore) and
 * test/storage/rules-oracle-conformance.test.ts (Storage). Unlike those two,
 * RTDB has NO server-side rules test API, so its production truth is captured by
 * DEPLOYING real rulesets, running ops against the live database, observing
 * allow/deny, and restoring — the `rtdb-simulator-vs-prod-agreement` oracle
 * probe. The `rules-corpus/rtdb/` scenarios are a decomposition of that probe (one
 * ruleset per scenario), and every case's `expectation` IS the production verdict
 * that probe froze. This suite runs the SAME (ruleset, op) tuples through the
 * in-process RTDB rules engine and asserts the simulator's allow/deny matches
 * the recorded production verdict — verdict for verdict.
 *
 * Because the prod-derived expectations live in the corpus itself (baked from
 * the frozen agreement observation), this replay is LIVE immediately — it does
 * not wait for a fresh `rules-rtdb-*` capture. When such captures do land, the
 * captured-observation cross-check below additionally asserts each capture's
 * verdict equals the corpus expectation, and completeness (no capture is left
 * un-replayed).
 *
 * KNOWN DIVERGENCES: a case where the simulator disagrees with the recorded
 * production verdict is a real divergence candidate, NOT a test to weaken. Such
 * a case is pinned in KNOWN_DIVERGENCES asserting BOTH sides (prod verdict AND
 * simulator verdict) so the suite stays green today but fails loudly the moment
 * either side moves, and is enumerated by the "enumerate simulator-vs-prod
 * divergences" test so it can never hide.
 *
 * CURRENT STATE: the in-process simulator agrees with every captured
 * production verdict except the r30 query-variable cases pinned in
 * KNOWN_DIVERGENCES. The r15 ancestor-validate false ALLOW is resolved: the
 * simulator now evaluates the full root-to-write validation path against the
 * merged post-write tree.
 *
 * DEPLOY SCENARIOS (`deployCases`) record whether production's rules endpoint
 * accepts a ruleset. Their captures are cross-checked against the corpus here;
 * whether Pyric's load-time check agrees with production is measured by the
 * RTDB rules scorecard, construct by construct.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbDeployScenario,
  type RtdbScenario,
} from '../../../../../packages/conformance/rules-corpus/rtdb/index.ts';
import { replayRtdbScenario } from '../../../../../packages/conformance/src/rules-rtdb-replay.ts';

// rules-rtdb-* observations live under the 'rtdb-rules' surface subdirectory
// (surfaces/rtdb-rules.ts owns the prefix), NOT the SDK-plane 'rtdb' one.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb-rules');

/**
 * Recorded simulator-vs-production divergences, pinned per the Firestore/Storage
 * KNOWN_DIVERGENCES convention: genuine, tracked gaps — never silently skipped.
 * Each entry pins BOTH sides so the suite stays green today but fails loudly the
 * moment either side's actual behavior changes, forcing a revisit.
 *
 * A regression or new divergence fails the replay assertion and the
 * enumerator below until it is fixed or pinned with both sides.
 *
 * Keyed by `${scenarioId} :: ${caseDescription}`.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; simVerdict: 'ALLOW' | 'DENY'; reason: string }
> = {
  'r30-query-rules :: orderByPriority reads true under orderByPriority': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'The simulated query carries no orderByPriority field, so query.orderByPriority never reads true.',
  },
  'r30-query-rules :: orderByKey reads false for a plain read': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'Production reads query.orderByKey as false for a read without a query; the simulator reads null.',
  },

  // FUZ-3 / MET-2 (rtdb-rules#28): r36-runtime-arithmetic-types (19/20 diverge)
  'r36-runtime-arithmetic-types :: FUZ-3: boolean minus number (true - 1 == 0)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `-` receives a boolean operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: numeric string minus number ("5" - 1 == 4)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `-` receives a string operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: non-numeric string minus number under || true ("abc" - 1 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `-` receives a string operand at runtime, even under `|| true`; the simulator evaluates to NaN and grants via `|| true`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: non-numeric string minus number under !(X == 0)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `-` receives a string operand at runtime; the simulator evaluates to NaN and grants `!(NaN == 0)`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: object minus number under || true ({a:1} - 1 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `-` receives an object operand at runtime, even under `|| true`; the simulator evaluates to NaN and grants via `|| true`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: boolean times number (true * 2 == 2)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `*` receives a boolean operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: numeric string times number ("3" * 2 == 6)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `*` receives a string operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: non-numeric string times number under || true ("abc" * 2 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `*` receives a string operand at runtime, even under `|| true`; the simulator evaluates to NaN and grants via `|| true`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: object times number under !(X == 0) (!({a:1} * 2 == 0))': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `*` receives an object operand at runtime; the simulator evaluates to NaN and grants `!(NaN == 0)`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: boolean divided by number (true / 2 == 0.5)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `/` receives a boolean operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: numeric string divided by number ("6" / 2 == 3)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `/` receives a string operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: object divided by number under || true ({a:1} / 2 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `/` receives an object operand at runtime, even under `|| true`; the simulator evaluates to NaN and grants via `|| true`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: boolean modulo number (true % 2 == 1)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `%` receives a boolean operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: numeric string modulo number ("7" % 4 == 3)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `%` receives a string operand at runtime; the simulator coerces via JavaScript arithmetic.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3: object modulo number under !(X == 0) (!({a:1} % 2 == 0))': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `%` receives an object operand at runtime; the simulator evaluates to NaN and grants `!(NaN == 0)`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3 / MET-2: unary minus on boolean (-true == -1)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when unary `-` receives a boolean operand at runtime; the simulator coerces via JavaScript unary `-`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3 / MET-2: unary minus on numeric string (-"5" == -5)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when unary `-` receives a string operand at runtime; the simulator coerces via JavaScript unary `-`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3 / MET-2: unary minus on non-numeric string under || true (-"abc" == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when unary `-` receives a string operand at runtime, even under `|| true`; the simulator evaluates to NaN and grants via `|| true`.',
  },
  'r36-runtime-arithmetic-types :: FUZ-3 / MET-2: unary minus on object under !(X == 0) (!(-{a:1} == 0))': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when unary `-` receives an object operand at runtime; the simulator evaluates to NaN and grants `!(NaN == 0)`.',
  },

  // FUZ-3 / MET-2 (rtdb-rules#28): r37-runtime-comparison-and-length-types (18/20 diverge)
  'r37-runtime-comparison-and-length-types :: FUZ-3: boolean plus number (true + 1 == 2)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `+` receives a boolean operand at runtime; the simulator coerces via JavaScript `+`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: boolean plus number under || true (false + 1 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `+` receives a boolean operand at runtime, even under `|| true`; the simulator evaluates `false + 1` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: object plus string ({a:1} + "!" == "[object Object]!")': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `+` receives an object operand at runtime; the simulator coerces via JavaScript `+`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: object plus number under || true ({a:1} + 1 == 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `+` receives an object operand at runtime, even under `|| true`; the simulator evaluates via JavaScript `+` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: boolean less than number (false < 1)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `<` compares a boolean and a number at runtime; the simulator coerces `false` to `0`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: string less than number ("1" < 2)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `<` compares a string and a number at runtime; the simulator coerces `"1"` to `1`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: string less than number under || true ("1" < 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `<` compares a string and a number at runtime, even under `|| true`; the simulator evaluates `"1" < 0` to `false` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: object less than number under || true ({a:1} < 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `<` receives an object operand at runtime, even under `|| true`; the simulator evaluates to `false` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: boolean greater than number (true > 0)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>` compares a boolean and a number at runtime; the simulator coerces `true` to `1`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: string greater than number ("2" > 1)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>` compares a string and a number at runtime; the simulator coerces `"2"` to `2`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: object greater than number under || true ({a:1} > 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>` receives an object operand at runtime, even under `|| true`; the simulator evaluates to `false` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: boolean greater than or equal to number (true >= 1)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>=` compares a boolean and a number at runtime; the simulator coerces `true` to `1`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: string greater than or equal to number ("2" >= 2)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>=` compares a string and a number at runtime; the simulator coerces `"2"` to `2`.',
  },
  'r37-runtime-comparison-and-length-types :: FUZ-3: object greater than or equal to number under || true ({a:1} >= 0 || true)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-3 / MET-2 (rtdb-rules#28): Production fails the rule when `>=` receives an object operand at runtime, even under `|| true`; the simulator evaluates to `false` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: MET-2: .length on a number under == 0 || true': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'MET-2 (rtdb-rules#28): Production fails the rule when `.length` is accessed on a number at runtime; the simulator returns `null` when `.length` is under `== 0 || true` and grants via `|| true`.',
  },
  'r37-runtime-comparison-and-length-types :: MET-2: .length on a number under !(X == 0)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'MET-2 (rtdb-rules#28): Production fails the rule when `.length` is accessed on a number at runtime; the simulator returns `null` and grants `!(null == 0)`.',
  },
  'r37-runtime-comparison-and-length-types :: MET-2: .length on an object with a length child ({length: 10}.length > 2)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'MET-2 (rtdb-rules#28): Production fails the rule when `.length` is accessed on an object at runtime; the simulator reads the object property `length: 10` and grants.',
  },
  'r37-runtime-comparison-and-length-types :: MET-2: .length on an object without a length child under == 0 || true': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'MET-2 (rtdb-rules#28): Production fails the rule when `.length` is accessed on an object at runtime; the simulator reads missing property `length` as `null` and grants via `|| true`.',
  },

  // COV-2 (rtdb-rules#29): r38-div-mod-by-zero (1/8 diverges)
  'r38-div-mod-by-zero :: COV-2: positive number divided by seeded 0 compared with > 100 (10 / 0 > 100)': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-2 (rtdb-rules#29): Production denies `10 / 0 > 100` when the divisor is 0; the simulator evaluates `10 / 0` to JavaScript `Infinity` and grants `Infinity > 100`.',
  },

  // COV-1 (rtdb-rules#30): r39-root-parent-runtime (5/7 diverge)
  'r39-root-parent-runtime :: COV-1: (true ? root.parent() : null) == null': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-1 (rtdb-rules#30): Production fails the rule when `root.parent()` is evaluated at runtime; the simulator returns `null` and grants `null == null`.',
  },
  'r39-root-parent-runtime :: COV-1: (true ? root.parent() : null) != null || true': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-1 (rtdb-rules#30): Production fails the rule when `root.parent()` is evaluated at runtime, even under `|| true`; the simulator returns `null` and grants via `|| true`.',
  },
  'r39-root-parent-runtime :: COV-1: ((true ? root.parent() : 1) == 1) || true': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-1 (rtdb-rules#30): Production fails the rule when `root.parent()` is evaluated at runtime, even under `|| true`; the simulator returns `null` and grants via `|| true`.',
  },
  'r39-root-parent-runtime :: COV-1: (true ? root.parent() : 1) != 1': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-1 (rtdb-rules#30): Production fails the rule when `root.parent()` is evaluated at runtime; the simulator returns `null` and grants `null != 1`.',
  },
  "r39-root-parent-runtime :: COV-1: (true ? root.parent() : '').length == null || true": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'COV-1 (rtdb-rules#30): Production fails the rule when `root.parent()` is evaluated at runtime, even under `|| true`; the simulator returns `null` and grants via `|| true`.',
  },

  // FUZ-4 (rtdb-rules#31): r40-auth-token-dynamic-index (2/4 diverge)
  'r40-auth-token-dynamic-index :: FUZ-4: auth.token[data.child("k").val()] == true with claim "null": true and missing k': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-4 (rtdb-rules#31): Production fails the rule when `auth.token[...]` is indexed by `null` (a missing child value); the simulator coerces `null` via `String(idx)` and looks up claim `"null"`.',
  },
  'r40-auth-token-dynamic-index :: FUZ-4: auth.token[data.child("k").val()] == true || true with missing k': {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'FUZ-4 (rtdb-rules#31): Production fails the rule when `auth.token[...]` is indexed by `null`, even under `|| true`; the simulator coerces `null` via `String(idx)` and grants via `|| true`.',
  },

  // COV-3 (rtdb-rules#32): r42-custom-token-standard-claims (10/12 diverge)
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.sub != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.sub` on custom-token sign-in; the replay/simulator custom-token builder omits `sub`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.sub == auth.uid': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production sets `auth.token.sub == auth.uid` on custom-token sign-in; the replay/simulator custom-token builder omits `sub`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.iat != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.iat` on custom-token sign-in; the replay/simulator custom-token builder omits `iat`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.exp != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.exp` on custom-token sign-in; the replay/simulator custom-token builder omits `exp`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.iss != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.iss` on custom-token sign-in; the replay/simulator custom-token builder omits `iss`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.aud != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.aud` on custom-token sign-in; the replay/simulator custom-token builder omits `aud`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.auth_time != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard JWT claim `auth.token.auth_time` on custom-token sign-in; the replay/simulator custom-token builder omits `auth_time`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.user_id != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates standard Firebase claim `auth.token.user_id` on custom-token sign-in; the replay/simulator custom-token builder omits `user_id`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.user_id == auth.uid': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production sets `auth.token.user_id == auth.uid` on custom-token sign-in; the replay/simulator custom-token builder omits `user_id`.',
  },
  'r42-custom-token-standard-claims :: COV-3: custom-token auth.token.firebase.identities != null': {
    prodVerdict: 'ALLOW',
    simVerdict: 'DENY',
    reason: 'COV-3 (rtdb-rules#32): Production populates `auth.token.firebase.identities` on custom-token sign-in; the replay/simulator custom-token builder omits `firebase.identities`.',
  },
};

interface RulesObservation {
  name: string;
  behavior: Record<string, unknown>;
}

const SCENARIO_BY_OBSERVATION = new Map<string, RtdbScenario>(
  ALL_RULES_RTDB_SCENARIOS.map((scenario) => [rtdbObservationName(scenario), scenario]),
);
const DEPLOY_SCENARIO_BY_OBSERVATION = new Map<string, RtdbDeployScenario>(
  ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((scenario) => [rtdbObservationName(scenario), scenario]),
);

function loadObservation(file: string): RulesObservation {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as {
    name?: string;
    behavior?: Record<string, unknown>;
  };
  return { name: raw.name ?? file.replace(/\.json$/, ''), behavior: raw.behavior ?? {} };
}

function capturedObservationFiles(): string[] {
  return readdirSync(OBS_DIR)
    .filter((f) => f.startsWith(RULES_RTDB_OBSERVATION_PREFIX) && f.endsWith('.json'))
    .sort();
}

describe('oracle conformance (rules-rtdb)', () => {
  // Corpus sanity: every scenario's subtree must compile. Runs regardless of
  // captures, so a malformed ruleset is caught here, not only at capture.
  it('every rtdb corpus scenario compiles', () => {
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
      expect(
        () => compileRtdbRules({ rules: { '.read': false, '.write': false, [scenario.id]: subtree } }),
        `scenario "${scenario.id}" must compile`,
      ).not.toThrow();
    }
  });

  // ── verdict-for-verdict replay against the prod-derived corpus expectations ──
  for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
    it(`${rtdbObservationName(scenario)}: simulator matches frozen production verdicts`, () => {
      for (const result of replayRtdbScenario(scenario)) {
        const key = `${scenario.id} :: ${result.caseKey}`;
        const known = KNOWN_DIVERGENCES[key];
        if (known) {
          // Pinned divergence: assert BOTH sides so the pin fails loudly the
          // moment production's recorded verdict or the simulator's behavior moves.
          expect(result.production, `${key} (recorded production verdict)`).toBe(known.prodVerdict);
          expect(result.simulator, `${key} (simulator verdict)`).toBe(known.simVerdict);
          continue;
        }
        expect(result.simulator, key).toBe(result.production);
      }
    });
  }

  // ── enumerate divergences prominently (findings, not hidden skips) ──────────
  it('enumerate simulator-vs-prod divergences (findings)', () => {
    const found: string[] = [];
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      for (const result of replayRtdbScenario(scenario)) {
        const key = `${scenario.id} :: ${result.caseKey}`;
        if (result.simulator !== result.production) {
          found.push(`${key} — prod ${result.production}, sim ${result.simulator}`);
        }
      }
    }
    // Every divergence found must be an explicitly-pinned, tracked one; an
    // unpinned divergence is a NEW finding and fails here.
    const unpinned = found.filter((f) => {
      const key = f.split(' — ')[0];
      return !KNOWN_DIVERGENCES[key];
    });
    expect(unpinned, `unpinned simulator-vs-prod divergences: ${JSON.stringify(unpinned, null, 2)}`).toEqual([]);
    // And every pinned divergence must actually still diverge (no stale pins).
    const foundKeys = new Set(found.map((f) => f.split(' — ')[0]));
    const stalePins = Object.keys(KNOWN_DIVERGENCES).filter((k) => !foundKeys.has(k));
    expect(stalePins, `stale divergence pins (no longer diverging): ${JSON.stringify(stalePins)}`).toEqual([]);
  });

  // ── captured-observation cross-check (live the moment captures exist) ───────
  // A fresh rules-rtdb-<id>.json capture re-confirms production truth. Assert
  // the corpus expectation equals the captured verdict for every case, and that
  // no captured observation is left without a corpus scenario.
  const files = capturedObservationFiles();
  for (const file of files) {
    const obs = loadObservation(file);
    const deployScenario = DEPLOY_SCENARIO_BY_OBSERVATION.get(obs.name);
    if (deployScenario) {
      it(`${obs.name}: corpus deploy verdicts match captured production verdicts`, () => {
        const expected = Object.fromEntries(
          deployScenario.deployCases.map((deployCase) => [deployCase.description, deployCase.expectation]),
        );
        expect(obs.behavior).toEqual(expected);
      });
      continue;
    }
    const scenario = SCENARIO_BY_OBSERVATION.get(obs.name);
    it(`${obs.name}: corpus expectations match captured production verdicts`, () => {
      expect(scenario, `observation "${obs.name}" has no matching corpus scenario — coverage gap`).toBeDefined();
      if (!scenario) return;
      const expByDesc = new Map(scenario.cases.map((c) => [c.description, c.expectation]));
      for (const [caseKey, capturedVerdict] of Object.entries(obs.behavior)) {
        const corpusExpectation = expByDesc.get(caseKey);
        expect(corpusExpectation, `${obs.name} :: ${caseKey} — captured case has no corpus twin`).toBeDefined();
        expect(corpusExpectation, `${obs.name} :: ${caseKey} (corpus expectation vs captured verdict)`).toBe(capturedVerdict);
      }
    });
  }

  it('every captured rules-rtdb observation maps to a corpus scenario', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !SCENARIO_BY_OBSERVATION.has(name) && !DEPLOY_SCENARIO_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
