/**
 * Traffic-conformance WIRING (SF-S4, plans/epic-scaffold-and-fill.md §S4).
 *
 * The pure check lives in `./traffic-conformance` (SF-S0c). This module
 * WIRES it into the two forms the epic asks for, and nothing more — it
 * does NOT reimplement the diff or duplicate any condition logic.
 *
 *   1. A GATE scoring entry point (`scoreConformance`) — pure over
 *      (spec, recorded traffic). This is what Wave 2's matrix calls to
 *      score an app-build run; it reads as a metric (violations,
 *      conformance rate). No I/O, deterministic, browser- AND node-safe.
 *
 *   2. An AMBIENT summary projector (`summarizeConformance`) — folds a
 *      full `ConformanceReport` into the compact, capped shape that rides
 *      back on a tool / validation result (report-don't-block, C1
 *      contract): a violations count + the worst few {path, method,
 *      identity, rule}.
 *
 *   3. Thin runtime adapters (`readAppSpecFromVfs`, `runtimeConformance`)
 *      that pull the spec from the VFS and the traffic from the runtime
 *      store and run the check. These are the only impure pieces; the
 *      scoring/summary functions above stay pure so the gate and the
 *      tests never touch the sandbox.
 *
 * THE TRAFFIC-AVAILABILITY SUBTLETY (why the seam is what it is):
 * conformance needs RECORDED traffic, which only exists AFTER the app has
 * actually run in the sandbox (the preview exercised it under some
 * identity). At `write_file` time the app the user just wrote has NOT been
 * exercised yet — any traffic present is from a PRIOR run. So the honest
 * ambient seam is "a point where traffic exists," NOT the write itself:
 *   - the on-demand `inspect_firestore_traffic` dump (the agent's natural
 *     "what did the app do?" query, after the preview ran) — primary seam;
 *   - the rules-write validation block, but ONLY over already-recorded
 *     traffic, surfaced as "conformance of the traffic captured so far"
 *     (never fabricated at write time).
 * We never manufacture traffic to fill a write-time check.
 */
import {
  validateAppSpec,
  type AppSpecV1,
  type AccessRule,
} from '~/lib/agent/spec/schema';
import {
  checkTrafficConformance,
  type ConformanceReport,
  type ConformanceViolation,
  type RecordedOp,
} from './traffic-conformance';

// ─────────────────────────────────────────────────────────────────────
// 1. GATE — pure scoring entry point (Wave 2's matrix metric)
// ─────────────────────────────────────────────────────────────────────

/**
 * The score Wave 2's matrix reads as a conformance metric for an
 * app-build run. Pure over (spec, recorded traffic): the app is exercised
 * under each spec identity, the resulting traffic is recorded, and this
 * scores it.
 */
export interface ConformanceScore {
  /** True iff the recorded traffic contains zero matrix violations. The
   *  headline pass/fail the matrix gates on. Conservative: indeterminate
   *  conditions (crossDoc/custom/enumTransition) never deny, so a `pass`
   *  is honest and a `fail` is a located off-contract affordance. */
  pass: boolean;
  /** Off-contract ops the app performed that the matrix denies. */
  violations: number;
  /** Ops the matrix granted for the acting identity (within contract). */
  conformant: number;
  /** Ops considered (== trafficLog.length). */
  opsChecked: number;
  /** Ops on paths no collection covers (reported, NOT counted against). */
  uncovered: number;
  /** conformant / (conformant + violations); 1 when there were no
   *  matrix-covered ops (nothing to disprove). The matrix's behavioral
   *  pass rate, ignoring uncovered ops. */
  conformanceRate: number;
  /** The full report, for callers that want the per-violation breakdown
   *  (the matrix archives this; the score fields above are the metric). */
  report: ConformanceReport;
}

/**
 * Score a recorded traffic log against an access matrix. The gate form of
 * the S0c harness: a pure entry point over (spec, recorded traffic) that
 * Wave 2's matrix run calls per app-build run.
 *
 * Pure — no I/O, deterministic, browser- and node-safe. Reuses
 * `checkTrafficConformance` (which reuses `evaluateGrant`); zero condition
 * logic is duplicated here.
 */
export function scoreConformance(
  spec: AppSpecV1,
  trafficLog: readonly RecordedOp[],
): ConformanceScore {
  const report = checkTrafficConformance(spec, trafficLog);
  const violations = report.violations.length;
  const decided = report.conformant + violations;
  return {
    pass: violations === 0,
    violations,
    conformant: report.conformant,
    opsChecked: report.opsChecked,
    uncovered: report.coverage.length,
    conformanceRate: decided === 0 ? 1 : report.conformant / decided,
    report,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 2. AMBIENT — compact summary projector (report-don't-block payload)
// ─────────────────────────────────────────────────────────────────────

/** Cap on the worst-few violations surfaced in an ambient summary — the
 *  block rides back in the tool result and is re-sent in history on every
 *  subsequent model call, so it must stay bounded (matches the C1 gate
 *  `CAP`). `violations` carries the true total. */
const AMBIENT_CAP = 5;

/** One off-contract affordance, compacted for the ambient block. */
export interface ConformanceFinding {
  path: string;
  /** The rules method the op lowered to. */
  method: string;
  /** The identity that performed it (uid, or 'anonymous'). */
  identity: string;
  /** Compact quote of the matrix rule that should have denied it. */
  rule: string;
  /** Why the matrix denied (first decidably-violated condition). */
  reason: string;
}

/**
 * The compact conformance section attached to an ambient result (the
 * traffic-dump tool / the rules-write validation block). Report-don't-
 * block: it is evidence, never a write barrier. Empty `findings` with
 * `violations: 0` = the recorded traffic is on-contract.
 */
export interface ConformanceSummary {
  /** Total off-contract ops in the recorded traffic. */
  violations: number;
  /** Ops within contract (matrix granted for the acting identity). */
  conformant: number;
  /** Ops considered. */
  opsChecked: number;
  /** Ops on paths no collection covers (informational). */
  uncovered: number;
  /** The worst few violations (capped at {@link AMBIENT_CAP}; `violations`
   *  carries the true count). */
  findings: ConformanceFinding[];
}

function quoteRule(rule: AccessRule): string {
  // `grant` is either the literal 'deny' (deny-by-default cell) or a
  // condition list (the AND of its `kind`s).
  const grant = rule.grant === 'deny' ? 'deny' : rule.grant.map((c) => c.kind).join('+');
  return `${rule.op} ${rule.collection} → ${grant}`;
}

function toFinding(v: ConformanceViolation): ConformanceFinding {
  return {
    path: v.path,
    method: v.method,
    identity: v.identity,
    rule: quoteRule(v.rule),
    reason: v.reason,
  };
}

/**
 * Fold a full `ConformanceReport` into the compact ambient summary. Pure.
 * Returns `null` when there is nothing worth surfacing — no ops were
 * checked at all (no recorded traffic). When traffic exists but is clean,
 * a summary with `violations: 0` is returned (positive signal: the app's
 * recorded behavior is on-contract).
 */
export function summarizeConformance(
  report: ConformanceReport,
): ConformanceSummary | null {
  if (report.opsChecked === 0) return null;
  return {
    violations: report.violations.length,
    conformant: report.conformant,
    opsChecked: report.opsChecked,
    uncovered: report.coverage.length,
    findings: report.violations.slice(0, AMBIENT_CAP).map(toFinding),
  };
}

/** One-line summary fragment for a tool-result summary string. */
export function summarizeConformanceLine(s: ConformanceSummary): string {
  if (s.violations === 0) {
    return `conformance clean (${s.conformant}/${s.opsChecked} on-contract)`;
  }
  return `conformance: ${s.violations} off-contract op${s.violations === 1 ? '' : 's'}`;
}

// ─────────────────────────────────────────────────────────────────────
// 3. RUNTIME ADAPTERS — the only impure pieces (VFS + store)
// ─────────────────────────────────────────────────────────────────────

/** Default workspace location of the access matrix (mirrors the
 *  draft-then-validate strategy's `specPath`). */
export const SPEC_PATH = '/workspace/app.spec.json';

/**
 * Read + validate the AppSpec from the workspace VFS. Returns the parsed
 * spec, or `null` when absent/unparseable/invalid — conformance is a
 * best-effort ambient overlay, so a missing or broken spec means "no
 * conformance signal," never an error (report-don't-block). The VFS
 * adapter is injected so callers in node/tests don't need a real OPFS.
 */
export async function readAppSpecFromVfs(
  readFile: (path: string) => Promise<string | null>,
  specPath: string = SPEC_PATH,
): Promise<AppSpecV1 | null> {
  let raw: string | null;
  try {
    raw = await readFile(specPath);
  } catch {
    return null;
  }
  if (!raw || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = validateAppSpec(parsed);
  return v.ok ? v.spec : null;
}

/**
 * Run conformance over (spec read from the VFS, traffic from the store)
 * and project the ambient summary. Returns `null` when there's no signal:
 * no spec, or no recorded traffic. This is the glue the ambient seams call
 * — it embodies the traffic-availability subtlety (it consumes ALREADY-
 * recorded traffic, it never runs the app).
 *
 * Dependencies are injected (readFile, traffic) so the seam wiring stays
 * testable without a live sandbox.
 */
export async function runtimeConformance(deps: {
  readFile: (path: string) => Promise<string | null>;
  traffic: readonly RecordedOp[];
  specPath?: string;
}): Promise<ConformanceSummary | null> {
  if (deps.traffic.length === 0) return null;
  const spec = await readAppSpecFromVfs(deps.readFile, deps.specPath);
  if (!spec) return null;
  const report = checkTrafficConformance(spec, deps.traffic);
  return summarizeConformance(report);
}
