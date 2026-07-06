/**
 * `simulate_firestore_write` — in-browser, deploy-free Firestore Rules
 * simulation. The agent passes a proposed ruleset, a method + path, an
 * auth context, and (for writes) a payload; the tool runs
 * `SimulateFirestoreRulesHandler.simulate()` and returns the decision
 * plus a structured per-rule trace and a one-line summary.
 *
 * Why this exists: writing rules and immediately calling `runOnce`
 * against the App preview produces a denial blurb, but the denial
 * doesn't tell the agent which expression in the rule caused it. The
 * simulator's per-rule trace is the closest thing we have to a "why"
 * for now. The agent can use this BEFORE deploying / running to
 * catch obvious gaps in the rule body without a feedback loop through
 * the sandbox.
 *
 * Trace shape: each `trace[i]` carries `ruleIndex`, `verdict`,
 * `line` (1-indexed source line of the `allow` keyword), and
 * `conditionText` (pretty-printed condition expression from the AST).
 * Per-EXPRESSION traces (which sub-expr short-circuited the OR chain)
 * are still a follow-up — they require extending the simulator's
 * evaluator, not this tool.
 *
 * Registration gate: this is a sandbox-local, parse-only tool —
 * no auth, no project, no network. `build(ctx)` in the manifest
 * returns the handler unconditionally; the master
 * `pyricDiagnosticsEnabled` toggle is handled by the caller in
 * `~/lib/tools/index.ts`.
 */
import type { ToolHandler } from '@inbrowser/agent';
import {
  SimulateFirestoreRulesHandler,
  type FunctionMock,
  type TestCase,
  type TestResult,
  type RuleEvaluation,
} from 'pyric/rules';
import { useWorkspaceStore } from '~/lib/store/workspace';

type Decision = 'ALLOW' | 'DENY' | 'UNSUPPORTED';
type Method = 'get' | 'list' | 'create' | 'update' | 'delete';
type WriteModeKind = 'create' | 'set' | 'update' | 'delete';

export interface SimulateFirestoreWriteArgs {
  /** Full Firestore Rules source to evaluate against. OPTIONAL — when
   *  omitted, the tool evaluates against the currently-deployed ruleset
   *  (the last source written to /workspace/firestore.rules). Pass it
   *  explicitly only to test a hypothetical ruleset you haven't written
   *  yet. Omitting it stops the agent re-shipping the whole ruleset on
   *  every simulate call (Epic #505, issue #514). */
  rules?: string;
  method: Method;
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  functionMocks?: FunctionMock[];
  requestTime?: string;
  writeMode?: { kind: WriteModeKind; merge?: boolean };
}

export interface SimulateFirestoreWriteData {
  decision: Decision;
  /** 1-indexed source line of the determining allow rule (the one whose
   *  verdict matches the overall decision). Null when the simulator
   *  abstained or no allow rule was evaluated. */
  matchedRuleLine: number | null;
  /** Single human-readable line, e.g.
   *  "Rule line 12 (update) → DENY · request.auth.uid != resource.data.ownerId".
   *  When the simulator abstains: "Simulator UNSUPPORTED — see trace."
   *  When parse fails: "Rules failed to parse — fix syntax before simulating." */
  summary: string;
  /** Per-rule structured trace from the simulator. Empty when no allow
   *  rule was evaluated (see `notes`). */
  trace: RuleEvaluation[];
  /** Top-level diagnostic strings (e.g. "No match block found for
   *  path 'X'"). Empty when an allow rule was evaluated. */
  notes: string[];
}

/**
 * Build a `ToolHandler` exposing `simulate_firestore_write`.
 *
 * Pure function over the agent args — no closures over auth/project
 * state because the simulator runs entirely in-process. Factory shape
 * is preserved for symmetry with the other diagnostic-tool builders.
 */
export function buildSimulateFirestoreWriteHandler(): ToolHandler<
  SimulateFirestoreWriteArgs,
  SimulateFirestoreWriteData
> {
  const sim = new SimulateFirestoreRulesHandler();

  return {
    name: 'simulate_firestore_write',
    // Parse-only, no shared state: safe to run concurrently with other
    // parallel-safe calls in a turn (0.2.0 parallelDispatch).
    parallelSafe: true,
    description:
      'Simulate a Firestore Rules evaluation locally — no deploy, no network. Give a method (get/list/create/update/delete), document path, auth context, and (for writes) the request payload. By default it evaluates against the DEPLOYED ruleset — the source you last wrote to /workspace/firestore.rules — so you do NOT need to pass `rules`; pass it only to test a hypothetical ruleset you haven\'t written yet. Returns the decision (ALLOW/DENY/UNSUPPORTED), the per-rule debug trace, and a one-line summary. Use this BEFORE shipping rules to catch denials without round-tripping through the App preview. The simulator implements most but not all Firestore Rules surface — on UNSUPPORTED, fall back to deploying + running.',
    parameters: {
      type: 'object',
      properties: {
        rules: {
          type: 'string',
          description:
            'OPTIONAL. Full Firestore Rules source to evaluate against. Omit to use the deployed ruleset (what you last wrote to /workspace/firestore.rules) — the normal case. Pass it only to test a hypothetical ruleset you have not written yet.',
        },
        method: {
          type: 'string',
          enum: ['get', 'list', 'create', 'update', 'delete'],
          description: 'Firestore method being attempted.',
        },
        path: {
          type: 'string',
          description: 'Relative document path, e.g. "users/alice" or "rooms/abc/messages/m1".',
        },
        auth: {
          description:
            'Auth context for the simulated request, or null for an unauthenticated caller. `uid` is required when set; `token` is the optional claims map.',
          oneOf: [
            {
              type: 'object',
              properties: {
                uid: { type: 'string' },
                token: { type: 'object', additionalProperties: true },
              },
              required: ['uid'],
            },
            { type: 'null' },
          ],
        },
        data: {
          type: 'object',
          additionalProperties: true,
          description:
            'request.resource.data for write operations (create/update/set/delete-with-precondition). Omit for get/list.',
        },
        resource: {
          type: 'object',
          additionalProperties: true,
          description:
            'Existing document data the rule sees as resource.data. Omit if the document does not exist.',
        },
        functionMocks: {
          type: 'array',
          description:
            'Mocks for get()/exists() calls inside the rules. Each mock specifies the document path the rule will look up and the data (or boolean for exists) to return.',
          items: {
            type: 'object',
            properties: {
              function: { type: 'string', enum: ['get', 'exists'] },
              path: { type: 'string' },
              result: {},
            },
            required: ['function', 'path', 'result'],
          },
        },
        requestTime: {
          type: 'string',
          description:
            'Override for request.time, ISO-8601 (e.g. "2026-01-01T00:00:00Z"). Defaults to wallclock when omitted — set this for date-gated rules.',
        },
        writeMode: {
          type: 'object',
          description:
            'Optional explicit write semantics. When set, controls update merge behavior and what getAfter() returns. When omitted, the simulator treats `data` as the full after-state.',
          properties: {
            kind: { type: 'string', enum: ['create', 'set', 'update', 'delete'] },
            merge: { type: 'boolean' },
          },
          required: ['kind'],
        },
      },
      required: ['method', 'path', 'auth'],
    },
    async execute(args) {
      // Rules resolution (#514): prefer the explicit `rules` arg; otherwise
      // fall back to the deployed ruleset — the source the agent last wrote
      // to /workspace/firestore.rules, mirrored into the workspace store.
      // This lets the agent simulate WITHOUT re-passing the whole ruleset on
      // every call (the ruleset otherwise appears ~N× in the growing context).
      const rulesSource =
        args.rules && args.rules.trim().length > 0
          ? args.rules
          : useWorkspaceStore.getState().rules;
      if (!rulesSource || rulesSource.trim().length === 0) {
        return {
          ok: false,
          summary: 'simulate_firestore_write · no rules to evaluate',
          data: {
            decision: 'UNSUPPORTED',
            matchedRuleLine: null,
            summary:
              'No rules supplied and none deployed. Write /workspace/firestore.rules first (it deploys automatically), then simulate without re-passing `rules` — or pass `rules` to test a hypothetical ruleset.',
            trace: [],
            notes: [],
          },
        };
      }

      const tc = buildTestCase(args);
      const result = sim.simulate(rulesSource, [tc]);

      // Parse failure surface — the simulator returns success:false with
      // a recoverable PARSE_FAILED error before it even enumerates the
      // testCases. Surface that as ok:false so the agent can react.
      if (!result.success) {
        return {
          ok: false,
          summary: `simulate_firestore_write · ${result.error.message}`,
          data: {
            decision: 'UNSUPPORTED',
            matchedRuleLine: null,
            summary: 'Rules failed to parse — fix syntax before simulating.',
            trace: [],
            notes: [result.error.message],
          },
        };
      }

      // Exactly one test case in → exactly one result out. Defensive
      // guard for the empty case so a regression in the simulator
      // doesn't crash the agent loop.
      const tr = result.data.results[0];
      if (!tr) {
        return {
          ok: false,
          summary: 'simulate_firestore_write · simulator returned no results',
          data: {
            decision: 'UNSUPPORTED',
            matchedRuleLine: null,
            summary: 'Simulator returned no results — internal error.',
            trace: [],
            notes: [],
          },
        };
      }

      const determining = findDeterminingEntry(tr);
      const matchedRuleLine = determining?.line ?? null;
      const summary = buildSummary(tr, determining);

      return {
        ok: true,
        summary: `simulate_firestore_write · ${args.method} ${args.path} → ${tr.decision}`,
        data: {
          decision: tr.decision,
          matchedRuleLine,
          summary,
          trace: tr.trace,
          notes: tr.notes,
        },
      };
    },
  };
}

// ─── Internals ────────────────────────────────────────────────────────

/**
 * Build a `TestCase` from the agent's args. We synthesize an
 * `expectation: 'ALLOW'` so the simulator runs — the actual decision
 * is read back off the result (state + final debug line), not off the
 * matched-expectation field. The simulator does NOT branch on
 * expectation other than for PASS/FAIL classification.
 */
function buildTestCase(args: SimulateFirestoreWriteArgs): TestCase {
  const tc: TestCase = {
    description: `simulate_firestore_write ${args.method} ${args.path}`,
    expectation: 'ALLOW',
    method: args.method,
    path: args.path,
    auth: args.auth,
  };
  if (args.data !== undefined) tc.data = args.data;
  if (args.resource !== undefined) tc.resource = args.resource;
  if (args.functionMocks !== undefined) tc.functionMocks = args.functionMocks;
  if (args.requestTime !== undefined) tc.requestTime = args.requestTime;
  if (args.writeMode !== undefined) {
    // The simulator's WriteMode schema is a discriminated union — `set`
    // requires `merge`; the other kinds reject extra fields. Build a
    // narrow object per kind so the type-narrow lines up with what
    // `projectAfterState` expects.
    switch (args.writeMode.kind) {
      case 'set':
        tc.writeMode = { kind: 'set', merge: args.writeMode.merge ?? false };
        break;
      case 'create':
      case 'update':
      case 'delete':
        tc.writeMode = { kind: args.writeMode.kind };
        break;
    }
  }
  return tc;
}

/**
 * Pick the trace entry that "determined" the overall decision:
 *   - ALLOW       → the entry with verdict ALLOW (always the last one,
 *                   since the simulator short-circuits on first ALLOW).
 *   - UNSUPPORTED → the last entry with verdict UNSUPPORTED.
 *   - DENY        → the last trace entry (the rule the simulator saw
 *                   most recently — usually the most informative one).
 * Returns null when the trace is empty (no allow rule was evaluated).
 */
function findDeterminingEntry(tr: TestResult): RuleEvaluation | null {
  if (tr.trace.length === 0) return null;
  if (tr.decision === 'ALLOW') {
    return tr.trace.find(e => e.verdict === 'ALLOW') ?? null;
  }
  if (tr.decision === 'UNSUPPORTED') {
    for (let i = tr.trace.length - 1; i >= 0; i--) {
      if (tr.trace[i].verdict === 'UNSUPPORTED') return tr.trace[i];
    }
  }
  return tr.trace[tr.trace.length - 1];
}

/**
 * Render a one-line summary of the decision from the structured trace.
 *
 * Format:
 *   "Rule line <N> (<ops>) → <DECISION> (<condition expr>)"   when a rule matched
 *   "Rule line <N> (<ops>) → UNSUPPORTED: <message>"          when sim abstained
 *   "<notes[0]> → DENY by default."                           when no rule evaluated
 *   "Decision: <DECISION>."                                   fallback
 */
function buildSummary(tr: TestResult, determining: RuleEvaluation | null): string {
  if (!determining) {
    if (tr.notes.length > 0) {
      return `${tr.notes[0]} → DENY by default.`;
    }
    return `Decision: ${tr.decision}.`;
  }

  const ops = determining.operations.join(',');
  const lineLabel = determining.line !== undefined
    ? `Rule line ${determining.line}`
    : `Rule #${determining.ruleIndex}`;

  if (determining.verdict === 'UNSUPPORTED') {
    const msg = determining.message ?? 'unsupported simulator surface';
    return `${lineLabel} (${ops}) → UNSUPPORTED: ${msg}`;
  }
  if (determining.verdict === 'ERROR') {
    const msg = determining.message ?? 'evaluation error';
    return `${lineLabel} (${ops}) → ERROR: ${msg}`;
  }
  const expr = determining.conditionText;
  return expr
    ? `${lineLabel} (${ops}) → ${tr.decision} (${expr})`
    : `${lineLabel} (${ops}) → ${tr.decision}`;
}
