/**
 * `try_rules_edit` — replay the current sandbox session against a
 * proposed rules edit and report (a) which previously-denied requests
 * would now succeed (the FIX) and (b) which previously-succeeded
 * writes would now be denied (REGRESSIONS).
 *
 * Why this exists: agent rule-editing without this is "guess and
 * deploy." The agent reads a denial blurb, makes an educated guess,
 * pushes to staging, waits for the next user attempt. Each cycle is
 * a deploy + observation round-trip. With `try_rules_edit`, the
 * agent verifies the proposed edit against the full captured session
 * history — every event the sandbox saw since the last `reset()` —
 * before suggesting it.
 *
 * Two-phase orchestration (one pass per phase, in this order):
 *
 *   1. **Regression check.** Replay captured `WriteSandboxEvent`s
 *      against the proposed rules via `replay(events, proposedRules,
 *      { pinRequestTime }, originalState)`. `replay()` swallows
 *      per-write denials internally (see
 *      `packages/sandbox/src/replay/index.ts:150`) — they don't throw
 *      out of the call. We detect them by passing `originalState` to
 *      `replay()` and reading the returned `real-divergence` entries
 *      where the path exists in `before` but not in `after`. Those
 *      are writes the proposed rules deny.
 *
 *   2. **Fix check.** Re-simulate every captured `RequestEvent` with
 *      `result: 'deny'` through `SimulateFirestoreRulesHandler`
 *      against the proposed rules. Any whose new `decision` is
 *      `'ALLOW'` is an unblocked fix.
 *
 * Reset behavior: `sandbox.history()` is per-sandbox and cleared on
 * `reset()`. If the user reset between bug-report and rule-edit
 * iteration, the tool sees an empty history and surfaces ok:false
 * with an explanatory summary so the agent doesn't propose a fix
 * "verified" against nothing.
 *
 * Out of scope this PR:
 *   - **Filter args** (`pathPrefix`, `eventIds`). All events count;
 *     the agent reads the summary stats and the per-event arrays.
 *     Filtering lands in a follow-up if the result-set sizes become
 *     unwieldy.
 *   - **Diffing payload field-level changes** beyond what
 *     `replay()`'s Divergence classifier already produces. The
 *     `drift` array carries the engine's output verbatim — the agent
 *     interprets, we don't pre-summarize.
 *   - **Auto-applying the fix.** The tool PROPOSES only — it
 *     evaluates the edit, returns the report, and stops. Applying
 *     happens via `writeRules` like any other rule change.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  replay,
  type SandboxEvent,
  type WriteSandboxEvent,
} from 'pyric/sandbox';
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules';
import { getPlaygroundRuntime } from '~/lib/sandbox/runtime';
import {
  classifyFixResults,
  classifyRegressions,
  partitionEvents,
  requestEventToTestCase,
  type TryRulesEditArgs,
  type TryRulesEditData,
} from './try-rules-edit.shared';

export type {
  TryRulesEditArgs,
  TryRulesEditData,
  UnblockedFix,
  Regression,
} from './try-rules-edit.shared';

export function buildTryRulesEditHandler(): ToolHandler<TryRulesEditArgs, TryRulesEditData> {
  const simulator = new SimulateFirestoreRulesHandler();

  return {
    name: 'try_rules_edit',
    description:
      'Verify a proposed Firestore Rules edit against the captured session history BEFORE applying it. Two-phase: (1) replays every previously-committed write under the proposed rules and reports which now fail (REGRESSIONS); (2) re-simulates every previously-denied request and reports which now succeed (UNBLOCKED FIXES). Returns structured `fix.unblocked[]` and `regression.nowDenied[]` arrays plus stats. Use this AFTER drafting a rule fix and BEFORE proposing it to the user — confirms the edit unblocks the failing case without breaking other flows. Operates on the in-browser sandbox\'s `history()`; resets clear history, so the agent should not reset between bug-report and verification.',
    parameters: {
      type: 'object',
      properties: {
        proposedRules: {
          type: 'string',
          description:
            'Full proposed-rules source. Will be parsed + replayed against; PARSE_FAILED produces ok:false with parseError populated.',
        },
        pinRequestTime: {
          type: 'boolean',
          description:
            'Default true. Pins request.time to each captured event\'s recorded time so date-gated rules evaluate identically across original and replay. Pass false only when intentionally testing time-drift behavior.',
        },
      },
      required: ['proposedRules'],
    },
    async execute(args) {
      let sandbox;
      try {
        sandbox = getPlaygroundRuntime().requireInProcessRunner('try_rules_edit').getSandbox();
      } catch (e) {
        return {
          ok: false,
          summary: `try_rules_edit · ${e instanceof Error ? e.message : String(e)}`,
          data: emptyData(),
        };
      }
      const events: SandboxEvent[] = sandbox.history();
      const env = getInternalEnv(sandbox);
      const originalState = env.snapshot();

      // Refuse on empty history. Without events the regression check
      // has nothing to replay and the fix check has nothing to
      // re-simulate. ok:true with empty arrays would silently report
      // "looks good" — that's a worse failure mode than the explicit
      // refusal here.
      if (events.length === 0) {
        return {
          ok: false,
          summary:
            'try_rules_edit · empty session — no captured events to verify against. Reproduce the failing flow first, then re-run.',
          data: emptyData(),
        };
      }

      const { deniedRequests, writes } = partitionEvents(events);

      // Phase 1 — replay all writes under proposed rules.
      let replayDivergences: TryRulesEditData['regression']['drift'] = [];
      let parseError: string | undefined;
      try {
        const result = replay(
          events,
          args.proposedRules,
          { pinRequestTime: args.pinRequestTime !== false },
          originalState,
        );
        replayDivergences = result.divergences;
      } catch (e) {
        // The replay engine seeds rules via env.seed(). A parse
        // failure surfaces as a thrown error — capture it as
        // parseError rather than crashing the tool call.
        parseError = e instanceof Error ? e.message : String(e);
      }

      if (parseError !== undefined) {
        return {
          ok: false,
          summary: `try_rules_edit · proposed rules failed to parse: ${parseError}`,
          data: { ...emptyData(), parseError },
        };
      }

      const regression = classifyRegressions(replayDivergences, writes);

      // Phase 2 — re-simulate every previously-denied request.
      const testCases: TestCase[] = [];
      const eventsWithCases: typeof deniedRequests = [];
      for (const ev of deniedRequests) {
        const tc = requestEventToTestCase(ev);
        if (tc) {
          testCases.push(tc);
          eventsWithCases.push(ev);
        }
      }

      let fix: TryRulesEditData['fix'] = { unblocked: [], stillDenied: 0, nowUnsupported: 0 };
      if (testCases.length > 0) {
        const sim = simulator.simulate(args.proposedRules, testCases);
        if (sim.success) {
          fix = classifyFixResults(eventsWithCases, sim.data.results);
        } else {
          // Simulator's PARSE_FAILED while replay() succeeded would be
          // weird (same source), but possible if `replay()` uses a
          // looser parser. Surface the discrepancy rather than silent-
          // failing the fix check.
          return {
            ok: false,
            summary: `try_rules_edit · simulator failed to parse proposed rules: ${sim.error.message}`,
            data: { ...emptyData(), parseError: sim.error.message, regression },
          };
        }
      }

      const fixes = fix.unblocked.length;
      const regressions = regression.nowDenied.length;
      const informational = regression.drift.length;
      return {
        ok: true,
        summary: summarize(fixes, regressions, informational, fix, regression, writes, deniedRequests),
        data: {
          parsed: true,
          stats: {
            historySize: events.length,
            deniedRequests: deniedRequests.length,
            succeededWrites: writes.length,
            fixes,
            regressions,
            informational,
          },
          fix,
          regression,
        },
      };
    },
  };
}

function emptyData(): TryRulesEditData {
  return {
    parsed: false,
    stats: {
      historySize: 0,
      deniedRequests: 0,
      succeededWrites: 0,
      fixes: 0,
      regressions: 0,
      informational: 0,
    },
    fix: { unblocked: [], stillDenied: 0, nowUnsupported: 0 },
    regression: { nowDenied: [], drift: [] },
  };
}

function summarize(
  fixes: number,
  regressions: number,
  informational: number,
  fix: TryRulesEditData['fix'],
  _regression: TryRulesEditData['regression'],
  writes: readonly WriteSandboxEvent[],
  deniedRequests: readonly { id: string }[],
): string {
  // Headline mirrors the agent's most important question: did my
  // fix work AND did it break anything? Show both counts up front
  // so the agent doesn't have to parse before deciding.
  const head = `try_rules_edit · ${fixes} fix${fixes === 1 ? '' : 'es'}, ${regressions} regression${regressions === 1 ? '' : 's'}`;
  const tail = [
    `${deniedRequests.length} previously-denied request${deniedRequests.length === 1 ? '' : 's'} re-simulated`,
    `${writes.length} previously-succeeded write${writes.length === 1 ? '' : 's'} re-applied`,
    `${fix.stillDenied} still denied · ${fix.nowUnsupported} now unsupported · ${informational} informational drift`,
  ];
  return `${head} (${tail.join(' · ')})`;
}
