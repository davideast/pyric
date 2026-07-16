/**
 * Rules evaluation — simulator-verdict helpers for the Firestore sandbox
 * engine (ADR-0007 mechanical extraction from `local-environment.ts`;
 * `SimulatorUnsupportedError` is re-exported there so the facade surface
 * is unchanged).
 */
import type { TestResult } from 'pyric/rules/internal';
import type { Timestamp } from 'pyric/rules/internal';

/**
 * Wallclock-aligned ISO string for `tc.requestTime`. Both `request.time`
 * and any `serverTimestamp()` sentinel in this write must resolve to a
 * field-equal Timestamp; we accomplish that by computing a single
 * Timestamp here and forwarding the millisecond-precise ISO to handler.ts
 * (which parses it back into a Timestamp via `Timestamp.fromIsoString`,
 * lossless on the millisecond grid).
 */
export function isoFromTimestamp(ts: Timestamp): string {
  return new Date(ts.toMillis()).toISOString();
}

/**
 * Thrown by `LocalEnvironment.execute` / `.batch` when the simulator
 * abstained on a rule (state: UNSUPPORTED). The agent's rule may be
 * correct — the simulator just doesn't implement the feature it uses.
 *
 * Returning `allowed: false` here would silently re-create the
 * misleading-DENY pattern that Item 0.A is designed to prevent (the
 * agent can't tell sim-gap apart from real rule bug). Throwing forces
 * the test to fail loudly with an actionable message pointing at the
 * production Test API as the workaround.
 */
export class SimulatorUnsupportedError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly path: string,
    public readonly debugMessages: string[],
  ) {
    super(message);
    this.name = 'SimulatorUnsupportedError';
  }
}

export function unsupportedMessage(method: string, path: string, debugMessages: string[]): string {
  const reasons = debugMessages
    .filter(m => m.includes('unsupported:'))
    .map(m => m.replace(/^.*unsupported:\s*/, ''))
    .join('; ');
  const reasonClause = reasons ? ` Reason(s): ${reasons}.` : '';
  return (
    `Simulator cannot decide ${method} on ${path} — the rule uses a feature ` +
    `the local simulator does not yet implement.${reasonClause} ` +
    `Verify this rule against production using TestFirestoreRulesHandler, ` +
    `or file a sim-gap entry in REBUILD_PLAN.md.`
  );
}

/**
 * A synthetic all-ALLOW {@link TestResult} for the admin-bypass path
 * (Pyric Studio Gap #2). Returned by {@link LocalEnvironment.runSimulate}
 * instead of calling the rules engine when an op carries `bypassRules`.
 * `state: 'PASSED'` + `decision: 'ALLOW'` is exactly the shape every
 * write/read site downstream of a `simulate()` call already branches on,
 * so the bypass reuses the entire existing execute/batch/transaction
 * apply + emit machinery unchanged — only the rule decision is forced.
 * The `notes` line makes the bypass legible in the `debugMessages` trail
 * that surfaces on the traffic log.
 */
export function adminBypassResult(description = ''): TestResult {
  return {
    description,
    expectation: 'ALLOW',
    state: 'PASSED',
    decision: 'ALLOW',
    trace: [],
    notes: ['admin lens — rules bypassed (Studio Gap #2)'],
  };
}

/**
 * Default ruleset for a freshly-constructed sandbox. Open read+write
 * on every path — the right behavior for the quickstart / local dev
 * loop where rules haven't been considered yet. Callers tighten this
 * via `setRules(...)`; production code never relies on the default.
 */
export const DEFAULT_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
`;
