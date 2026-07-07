/**
 * Pure helpers for `try_rules_edit`. Two-phase rule-edit verifier:
 *
 *   1. **Regression check** — replay captured writes against proposed
 *      rules, look for `real-divergence` entries that signal "this
 *      write no longer applies under proposed rules" (i.e. the new
 *      rules deny something that used to succeed).
 *
 *   2. **Fix check** — re-simulate captured `request` events with
 *      `result: 'deny'` against proposed rules; any whose new
 *      decision is `ALLOW` is an unblocked fix.
 *
 * The handler that wires the active in-process sandbox is in
 * `try-rules-edit.ts`. This file holds the pure logic so tests can
 * exercise it without the runner singleton or workspace-dep chain.
 */
import type {
  SandboxEvent,
  RequestEvent,
  WriteSandboxEvent,
  Divergence,
  AuthState,
} from 'pyric/sandbox';
import type { TestCase, TestResult } from 'pyric/rules';

// ─── Public arg / result shapes ──────────────────────────────────────

export interface TryRulesEditArgs {
  /** Full proposed-rules source the agent wants to test. */
  proposedRules: string;
  /** When true (default), `replay()` pins `request.time` to each
   *  captured event's `requestTime` so date-gated rules evaluate
   *  identically across original and replay. Pass `false` only when
   *  the agent is intentionally testing time-drift behavior. */
  pinRequestTime?: boolean;
}

/**
 * Compact view of a previously-denied request that the proposed rules
 * would now allow. The full `RequestEvent` is preserved on `event`
 * for the agent to inspect (`reasons`, `request.resourceData`,
 * `resourceBefore`, etc.); the unwrapped fields are convenience for
 * scannable summaries.
 */
export interface UnblockedFix {
  /** Unique id from the captured `RequestEvent`. Lets the agent
   *  cross-reference against `inspect_firestore_traffic` results. */
  eventId: string;
  path: string;
  method: RequestEvent['method'];
  /** Auth identity at the time of the original denial. */
  auth: AuthState;
  /** The original denial's reason strings — usually the simulator's
   *  per-rule trace. Lets the agent confirm "yes, this is the case I
   *  meant to fix." */
  originalReasons: string[];
  /** Full original event for deeper drill-in. */
  event: RequestEvent;
}

/**
 * Compact view of a previously-allowed write that the proposed rules
 * would now deny (or substantially alter). Detected via `replay()`
 * returning a `real-divergence` for the path with `after: undefined`
 * (the write couldn't apply against the proposed rules).
 */
export interface Regression {
  /** Unique id from the captured `WriteSandboxEvent`. */
  eventId: string;
  path: string;
  method: WriteSandboxEvent['method'];
  /** Auth identity at the time of the original write. */
  auth: AuthState;
  /** Full original write event so the agent can render diffs / payload
   *  details without re-deriving from out-of-band state. */
  event: WriteSandboxEvent;
}

export interface TryRulesEditFixSummary {
  /** Previously-denied requests the proposed rules would now allow. */
  unblocked: UnblockedFix[];
  /** Previously-denied requests that stay denied (intended denials). */
  stillDenied: number;
  /** Previously-denied requests where the simulator now abstains
   *  (UNSUPPORTED — feature not modelled). Not a fix, not a regression;
   *  flagged for transparency. */
  nowUnsupported: number;
}

export interface TryRulesEditRegressionSummary {
  /** Previously-succeeded writes the proposed rules would now deny. */
  nowDenied: Regression[];
  /** Other divergences from `replay()` — autoid-alias, sentinel-drift,
   *  time-drift, plus field-level real-divergences that aren't "path
   *  missing". Informational; surfaced so the agent can audit unexpected
   *  side effects of the rule edit. */
  drift: Divergence[];
}

export interface TryRulesEditData {
  /** Whether the proposed rules parsed at all. When false, every
   *  other field is empty and `parseError` carries the diagnostic. */
  parsed: boolean;
  parseError?: string;
  /** Aggregate counts the agent can quote without walking the lists. */
  stats: {
    historySize: number;
    deniedRequests: number;
    succeededWrites: number;
    fixes: number;
    regressions: number;
    informational: number;
  };
  fix: TryRulesEditFixSummary;
  regression: TryRulesEditRegressionSummary;
}

// ─── RequestEvent → TestCase ─────────────────────────────────────────

/**
 * Convert a captured `RequestEvent` into a `TestCase` the rules
 * simulator can re-evaluate. Returns null for events the simulator
 * can't directly model (today: none — every captured method is
 * representable). The shape kept null-returning to leave room for
 * future filters without a breaking change.
 *
 * Two non-obvious mappings:
 *
 * 1. **`method: 'set'`** — RequestEvent's sandbox-side method enum
 *    includes `'set'`, but `TestCase.method` does not. We map to
 *    `'update'` if the doc existed (`resourceBefore.exists === true`)
 *    or `'create'` otherwise, and attach `writeMode: { kind: 'set',
 *    merge: false }` so `projectAfterState` projects the resolved
 *    `request.resource.data` and `getAfter()` correctly. The `merge`
 *    flag isn't captured on the request event today; default
 *    `false` matches the sandbox's standard `setDoc` semantics.
 *
 * 2. **`auth`** — `AuthState`'s shape (`{uid, token?} | null`)
 *    matches `TestCase.auth` directly. Passed through unchanged.
 */
export function requestEventToTestCase(event: RequestEvent): TestCase | null {
  const sandboxMethod = event.method;
  let tcMethod: TestCase['method'];
  let writeMode: TestCase['writeMode'] | undefined;

  if (sandboxMethod === 'set') {
    const existed = event.resourceBefore?.exists === true;
    tcMethod = existed ? 'update' : 'create';
    writeMode = { kind: 'set', merge: false };
  } else {
    tcMethod = sandboxMethod;
  }

  const tc: TestCase = {
    description: `try_rules_edit · replay ${event.id} (${event.method} ${event.path})`,
    expectation: 'ALLOW',
    method: tcMethod,
    path: event.path,
    auth: event.auth,
  };
  if (event.request?.resourceData !== undefined) {
    tc.data = event.request.resourceData;
  }
  if (event.resourceBefore?.data) {
    tc.resource = event.resourceBefore.data;
  }
  if (writeMode) {
    tc.writeMode = writeMode;
  }
  return tc;
}

// ─── Result classification ───────────────────────────────────────────

/**
 * Bucket re-simulated denied requests by their NEW decision under the
 * proposed rules. `simResults` MUST line up index-for-index with
 * `deniedRequests`. ALLOW → unblocked; DENY → stillDenied; UNSUPPORTED
 * → nowUnsupported.
 */
export function classifyFixResults(
  deniedRequests: readonly RequestEvent[],
  simResults: readonly TestResult[],
): TryRulesEditFixSummary {
  const unblocked: UnblockedFix[] = [];
  let stillDenied = 0;
  let nowUnsupported = 0;

  for (let i = 0; i < deniedRequests.length; i++) {
    const event = deniedRequests[i];
    const result = simResults[i];
    if (!event || !result) continue;
    if (result.decision === 'ALLOW') {
      unblocked.push({
        eventId: event.id,
        path: event.path,
        method: event.method,
        auth: event.auth,
        originalReasons: event.reasons,
        event,
      });
    } else if (result.decision === 'UNSUPPORTED') {
      nowUnsupported++;
    } else {
      stillDenied++;
    }
  }

  return { unblocked, stillDenied, nowUnsupported };
}

/**
 * Classify `replay()` divergences into two buckets:
 *
 * 1. **`nowDenied`**: regressions. A `real-divergence` with
 *    `after === undefined` means the path exists in the original
 *    state but not in the replayed state — replay couldn't apply
 *    that write, almost certainly because the proposed rules deny
 *    it. We pair each such divergence with the matching captured
 *    `WriteSandboxEvent` so the agent gets the full op context.
 *
 * 2. **`drift`**: everything else. Autoid-alias, sentinel-drift,
 *    time-drift are informational by design (replay engine licenses
 *    them via captured metadata). Field-level `real-divergence`
 *    entries (where the path exists but a field differs) land here
 *    too — they're "something changed" but not "the write was
 *    denied," so they don't count as regressions for the fix-check
 *    summary.
 */
export function classifyRegressions(
  divergences: readonly Divergence[],
  writes: readonly WriteSandboxEvent[],
): TryRulesEditRegressionSummary {
  const writesByPath = new Map<string, WriteSandboxEvent>();
  for (const w of writes) {
    // Latest write at the path wins — that's the one whose absence
    // would surface as the regression.
    writesByPath.set(w.path, w);
  }

  const nowDenied: Regression[] = [];
  const drift: Divergence[] = [];

  for (const d of divergences) {
    if (
      d.kind === 'real-divergence' &&
      d.field === undefined &&
      d.after === undefined &&
      d.before !== undefined
    ) {
      // Doc present in original, missing in replay = write couldn't
      // apply = regression.
      const write = writesByPath.get(d.path);
      if (write) {
        nowDenied.push({
          eventId: write.id,
          path: write.path,
          method: write.method,
          auth: write.auth,
          event: write,
        });
        continue;
      }
      // Path-missing divergence without a matching write event is
      // unusual (state had a doc but no write produced it). Drop
      // into drift so we don't drop the signal entirely.
    }
    drift.push(d);
  }

  return { nowDenied, drift };
}

// ─── Top-level orchestration helper ──────────────────────────────────

/**
 * Filter a captured event stream to the inputs each phase consumes:
 * denied requests (for the fix check) and committed writes (for the
 * regression check). Single pass for both. Counts match what the
 * `stats` block in `TryRulesEditData` reports.
 */
export function partitionEvents(events: readonly SandboxEvent[]): {
  deniedRequests: RequestEvent[];
  writes: WriteSandboxEvent[];
} {
  const deniedRequests: RequestEvent[] = [];
  const writes: WriteSandboxEvent[] = [];
  for (const e of events) {
    if (e.kind === 'request' && e.result === 'deny') {
      deniedRequests.push(e);
    } else if (e.kind === 'write') {
      writes.push(e);
    }
  }
  return { deniedRequests, writes };
}
