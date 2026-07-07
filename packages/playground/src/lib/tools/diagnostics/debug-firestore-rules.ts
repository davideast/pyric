/**
 * `debug_firestore_rules` — orchestrator that composes existing
 * diagnostic primitives into one synthesized "why did this rule
 * deny?" report. Auto-locates the failing event from the traffic
 * ring buffer (or accepts an explicit `eventId`), re-simulates it
 * against the supplied rules with the per-expression trace from #458,
 * pulls the sandbox state at the path via admin read, runs lint,
 * and produces a `diagnosis` with a heuristic likely-cause + the
 * load-bearing failing expression + human-readable notes.
 *
 * Why this exists: the agent's debug loop without this is "find the
 * denial, run simulate, read trace, run admin read, run lint, build
 * a mental model." That's 4+ tool calls before any actual reasoning.
 * The orchestrator collapses the round-trips and adds a synthesized
 * diagnosis layer the agent can quote directly to the user.
 *
 * Composition map:
 *   - traffic ring buffer (`useRuntimeStore.getState().traffic`) —
 *     auto-locate the event
 *   - `SimulateFirestoreRulesHandler` (PR #457/#458/#459) —
 *     structured trace + per-expression trace + inlinedFrom
 *   - `LocalEnvironment.admin.getDocument` — admin-bypass state read
 *   - `lintFirestoreRules` — known-pitfall scan
 *
 * Out of scope this PR:
 *   - **`proposedRules` verification.** When the agent has a fix in
 *     mind, running it through `try_rules_edit` (PR #462) to check
 *     regressions + verify the fix is the natural next step. Lands
 *     once #462 merges to avoid a cross-branch dep.
 *   - **Hypothesis mode** (synthetic case without a traffic event).
 *     Today the orchestrator requires an event; the agent can still
 *     use `simulate_firestore_write` directly for synthetic cases.
 *   - **Auto-suggested fix diffs.** The diagnosis names the cause and
 *     points at the failing leaf; the agent renders the actual fix.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { lintFirestoreRules } from 'pyric/rules';
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
  type RuleEvaluation,
} from 'pyric/rules';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import { useRuntimeStore, type TrafficEntry } from '~/lib/store/runtime';
import type { RequestEvent } from 'pyric/sandbox';
import {
  buildDiagnosis,
  type DebugFirestoreRulesArgs,
  type DebugFirestoreRulesDiagnosis,
  type FailingExpression,
  type LikelyCause,
} from './debug-firestore-rules.shared';

export type {
  DebugFirestoreRulesArgs,
  DebugFirestoreRulesDiagnosis,
  FailingExpression,
  LikelyCause,
} from './debug-firestore-rules.shared';

export interface DebugFirestoreRulesData {
  /** Where the debug target came from + the underlying event. */
  trigger: {
    source: 'event-id' | 'latest-denial';
    eventId: string;
    /** The traffic entry the simulation was reconstructed from. */
    event: TrafficEntry;
  };
  /** Compact view of the re-simulation under the supplied rules. */
  simulation: {
    decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
    summary: string;
    /** Pretty-printed condition of the rule the simulator picked as
     *  determining. Absent when no rule was evaluated (path mismatch). */
    conditionText?: string;
    /** 1-indexed source line of the determining rule. */
    line?: number;
  };
  diagnosis: DebugFirestoreRulesDiagnosis;
}

/**
 * Combined args + rules (the latter mandatory). Kept out of the
 * shared module because it's the tool's public surface, not a
 * helper-internal type.
 */
interface FullArgs extends DebugFirestoreRulesArgs {
  rules: string;
}

type FirestoreTrafficEntry = RequestEvent & { truncated?: boolean };

function isFirestoreTrafficEntry(entry: TrafficEntry): entry is FirestoreTrafficEntry {
  return entry.kind === 'request';
}

export function buildDebugFirestoreRulesHandler(): ToolHandler<FullArgs, DebugFirestoreRulesData> {
  const simulator = new SimulateFirestoreRulesHandler();

  return {
    name: 'debug_firestore_rules',
    parallelSafe: true, // read-only diagnostic (0.2.0 parallelDispatch)
    description:
      'One-call diagnostic: locate the failing event from the sandbox traffic ring buffer (or by `eventId`), re-simulate it against the supplied rules with the structured expression trace, pull the sandbox state at the failing path, run lint, and synthesize a `diagnosis` with a heuristic likely-cause classification + the load-bearing failing expression + human-readable notes. Use this BEFORE proposing a rule fix — replaces a 4-tool debugging sequence (inspect_firestore_traffic → simulate_firestore_write → admin read → lint) with one structured result. Operates on the in-browser sandbox; `rules` arg is the source the agent wants to debug against (typically the current editor contents).',
    parameters: {
      type: 'object',
      properties: {
        rules: {
          type: 'string',
          description:
            'Full rules source to simulate against. Typically the current editor contents — pass whatever the agent is reasoning about.',
        },
        eventId: {
          type: 'string',
          description:
            'Optional. Specific traffic entry to debug (cross-reference from `inspect_firestore_traffic`). When omitted, the tool falls back to the latest denial in the ring buffer.',
        },
      },
      required: ['rules'],
    },
    async execute(args) {
      // 1. Resolve which traffic entry we're debugging.
      const traffic = useRuntimeStore.getState().traffic;
      const located = locateEvent(traffic, args.eventId);
      if (!located) {
        const reason = args.eventId
          ? `eventId '${args.eventId}' not found in traffic ring buffer`
          : 'no denied requests in traffic ring buffer';
        return {
          ok: false,
          summary: `debug_firestore_rules · ${reason}`,
          data: emptyData(),
        };
      }
      const { event, source } = located;

      // 2. Reconstruct a TestCase from the event and re-simulate
      //    against the supplied rules.
      const tc = trafficEntryToTestCase(event);
      const simResult = simulator.simulate(args.rules, [tc]);
      if (!simResult.success) {
        return {
          ok: false,
          summary: `debug_firestore_rules · ${simResult.error.message}`,
          data: {
            trigger: { source, eventId: event.id, event },
            simulation: {
              decision: 'UNSUPPORTED',
              summary: 'Rules failed to parse — fix syntax before debugging.',
            },
            diagnosis: {
              likelyCause: 'UNSUPPORTED_SURFACE',
              lintFindings: [],
              pathNearMisses: [],
              notes: [
                `Rules parse error: ${simResult.error.message}`,
              ],
            },
          },
        };
      }
      const tr = simResult.data.results[0];
      if (!tr) {
        return {
          ok: false,
          summary: 'debug_firestore_rules · simulator returned no results',
          data: emptyData(),
        };
      }

      // 3. Admin-bypass read at the failing path so the agent can
      //    confirm "the rule reads owner=X but the doc actually has
      //    owner=Y" without an extra round-trip. Wrapped in
      //    try/catch because admin reads from a fresh sandbox can
      //    throw on non-existent collection paths (treated as null).
      let sandboxStateAtPath: Record<string, unknown> | null = null;
      try {
        const sandbox = getPlaygroundRuntime().requireInProcessRunner('debug_firestore_rules sandbox state lookup').getSandbox();
        const env = getInternalEnv(sandbox);
        const doc = env.getDocument(event.path);
        sandboxStateAtPath = (doc as Record<string, unknown> | null) ?? null;
      } catch {
        sandboxStateAtPath = null;
      }

      // 4. Lint the rules. Always runs — even when the simulation
      //    succeeded, the rules might have a known pitfall pattern.
      const lintResult = lintFirestoreRules(args.rules);
      // LintWarning.location carries structural pointers (functionName /
      // ruleIndex / matchPath / testCaseDescription), not source line
      // numbers. Pass them through verbatim so the agent can scope the
      // finding to a rule without having to re-parse.
      const lintFindings = lintResult.warnings.map(w => ({
        message: w.message,
        severity: w.severity,
        ruleIndex: w.location?.ruleIndex,
        matchPath: w.location?.matchPath,
        functionName: w.location?.functionName,
      }));

      // 5. Synthesize the diagnosis. All the analysis logic lives in
      //    the pure `buildDiagnosis` so the handler stays a thin
      //    orchestrator (and the analysis is unit-testable without
      //    the runner singleton).
      const diagnosis = buildDiagnosis({
        tr,
        event: { method: event.method, path: event.path, auth: event.auth },
        sandboxStateAtPath,
        lintFindings,
      });
      const determining = pickDetermining(tr.trace);
      const failing = diagnosis.failingExpression;

      return {
        ok: true,
        summary: `debug_firestore_rules · ${tr.decision} at ${event.method} ${event.path} · ${diagnosis.likelyCause}`,
        data: {
          trigger: { source, eventId: event.id, event },
          simulation: {
            decision: tr.decision,
            summary: failing
              ? `${tr.decision}: failing leaf \`${failing.source}\` = ${JSON.stringify(failing.value)}`
              : `${tr.decision}`,
            ...(determining?.conditionText !== undefined && { conditionText: determining.conditionText }),
            ...(determining?.line !== undefined && { line: determining.line }),
          },
          diagnosis,
        },
      };
    },
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Find the target event in the traffic ring buffer. Explicit
 * `eventId` wins; otherwise scan backwards for the latest denial.
 * Returns null when neither lookup yields a hit.
 */
function locateEvent(
  traffic: readonly TrafficEntry[],
  eventId: string | undefined,
): { event: FirestoreTrafficEntry; source: 'event-id' | 'latest-denial' } | null {
  if (eventId !== undefined) {
    const event = traffic.find(t => t.id === eventId);
    if (!event || !isFirestoreTrafficEntry(event)) return null;
    return { event, source: 'event-id' };
  }
  for (let i = traffic.length - 1; i >= 0; i--) {
    const event = traffic[i];
    if (event && isFirestoreTrafficEntry(event) && event.result === 'deny') {
      return { event, source: 'latest-denial' };
    }
  }
  return null;
}

/**
 * Inline `RequestEvent` → `TestCase` mapper. Mirrors what
 * `try_rules_edit.shared.ts` carries (PR #462). Duplicated rather
 * than extracted to avoid a cross-branch dep while both PRs are
 * open; can consolidate once both land.
 *
 * Method mapping: sandbox enum has `set`, TestCase doesn't. Map to
 * `create` (if no prior doc) or `update` (if prior doc existed),
 * with `writeMode: { kind: 'set', merge: false }`.
 */
function trafficEntryToTestCase(event: FirestoreTrafficEntry): TestCase {
  let method: TestCase['method'];
  let writeMode: TestCase['writeMode'] | undefined;
  if (event.method === 'set') {
    const existed = event.resourceBefore?.exists === true;
    method = existed ? 'update' : 'create';
    writeMode = { kind: 'set', merge: false };
  } else {
    method = event.method;
  }
  const tc: TestCase = {
    description: `debug_firestore_rules · replay ${event.id} (${event.method} ${event.path})`,
    expectation: 'ALLOW',
    method,
    path: event.path,
    auth: event.auth,
  };
  if (event.request?.resourceData !== undefined) tc.data = event.request.resourceData;
  if (event.resourceBefore?.data) tc.resource = event.resourceBefore.data;
  if (writeMode) tc.writeMode = writeMode;
  return tc;
}

function pickDetermining(trace: readonly RuleEvaluation[]): RuleEvaluation | undefined {
  if (trace.length === 0) return undefined;
  // Same selection logic as extractFailingExpression: prefer
  // UNSUPPORTED, else last entry (most informative under OR semantics).
  const unsupported = trace.find(e => e.verdict === 'UNSUPPORTED');
  return unsupported ?? trace[trace.length - 1];
}

function emptyData(): DebugFirestoreRulesData {
  return {
    trigger: {
      source: 'latest-denial',
      eventId: '',
      // Synthetic placeholder — the consumer checks ok:false and
      // ignores the data block in failure paths.
      event: {
        kind: 'request',
        id: '',
        at: 0,
        evalMs: 0,
        method: 'get',
        path: '',
        auth: null,
        result: 'deny',
        reasons: [],
        origin: 'user',
      },
    },
    simulation: {
      decision: 'UNSUPPORTED',
      summary: '',
    },
    diagnosis: {
      likelyCause: 'RULE_REJECTED_VALID',
      lintFindings: [],
      pathNearMisses: [],
      notes: [],
    },
  };
}
