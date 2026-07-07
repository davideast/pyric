/**
 * Rules-failure debugging: the pure view-model (Pyric Studio F4).
 *
 * Everything here is a PURE function over the unified event stream
 * ({@link SandboxEvent}), no React, no worker, no DOM. The UI (`RulesDebug.tsx`)
 * renders these shapes; the re-run actions (`rerun.ts`) consume a {@link Denial}.
 * Factoring the denial→rule→context derivation out as data makes it unit-testable
 * without a browser (see `rules-debug.test.ts`).
 *
 * WHERE THE DATA COMES FROM
 * -------------------------
 * A denied op is just a `RequestEvent` with `result === 'deny'`. That event
 * already carries everything the panel needs:
 *   - `reasons[]`     the simulator's per-rule trace (`Rule #N (ops) → deny`).
 *   - `matchedRule`   `{ ruleIndex, operations }` parsed from that trace.
 *   - `auth`          the `request.auth` context the rule saw (or `null`).
 *   - `method`/`path` the op + resource path.
 *   - `request.resourceData` the proposed write (create/update/set).
 *   - `resourceBefore`       the existing doc the rule saw.
 * So "show the rule that denied it, the request.auth context, and the path/op"
 * is a projection, no re-derivation from out-of-band state.
 */

import type {
  AuthState,
  RequestEvent,
  SandboxEvent,
  SandboxOperationEvent,
} from 'pyric/sandbox';

type DeniedSandboxEvent = RequestEvent | SandboxOperationEvent;

/** A single denied operation, projected from a `result:'deny'` request event. */
export interface Denial {
  /** The originating request event's id (stable React key + correlation). */
  id: string;
  /** Wall-clock at op start (ms since epoch). */
  at: number;
  /** The operation the rule rejected. */
  method: RequestEvent['method'] | string;
  /** Service whose rules rejected the operation. */
  service: 'firestore' | 'auth' | 'storage' | 'rtdb' | string;
  /** Full resource path (e.g. `notes/abc`). */
  path: string;
  /** The `request.auth` identity the rule evaluated under (`null` = anonymous). */
  auth: AuthState;
  /** The rule that denied, parsed from the simulator trace. Absent when no
   *  rule even tried to match (implicit deny: no `allow` at the path). */
  matchedRule?: { ruleIndex: number; operations: string[] };
  /** Raw simulator trace lines (`Rule #N (ops) → deny`, plus context lines). */
  reasons: string[];
  /** Proposed write payload (create/update/set). Absent on reads + delete. */
  resourceData?: unknown;
  /** Existing doc state the rule saw (`null`/`exists:false` ⇒ absent doc). */
  resourceBefore?: { data: unknown; exists: boolean };
  /** Where the op came from (user op, listener re-eval, batch, transaction). */
  origin: RequestEvent['origin'] | SandboxOperationEvent['origin'];
  /** `'unsupported'` denials (simulator hit an unmodelled feature) are flagged
   *  so the UI can distinguish them from a genuine rule rejection. */
  unsupported: boolean;
}

/** Type guard: a request event the rules engine rejected (deny or unsupported). */
function isDeniedRequest(e: SandboxEvent): e is DeniedSandboxEvent {
  return (
    (e.kind === 'request' || e.kind === 'operation') &&
    (e.result === 'deny' || e.result === 'unsupported')
  );
}

function serviceOf(e: DeniedSandboxEvent): string {
  return 'service' in e && typeof e.service === 'string' ? e.service : 'firestore';
}

function requestDataOf(e: DeniedSandboxEvent): unknown {
  const request = e.request;
  if (!request) return undefined;
  if ('resourceData' in request && request.resourceData !== undefined) return request.resourceData;
  if ('data' in request) return request.data;
  return undefined;
}

/**
 * Project the unified event stream down to the denied operations, newest first.
 *
 * Pass `sandbox.history()` or an accumulated `onEvent` buffer. Listener re-evals
 * that denied (`origin:'listener'`) are included: a watch that started erroring
 * after a rules change is exactly the kind of failure F4 exists to explain.
 */
export function selectDenials(events: readonly SandboxEvent[]): Denial[] {
  const out: Denial[] = [];
  for (const e of events) {
    if (!isDeniedRequest(e)) continue;
    out.push(toDenial(e));
  }
  // Newest first: the most recent failure is the one you're debugging.
  return out.sort((a, b) => b.at - a.at);
}

/** Project one `result:'deny'`/`'unsupported'` request event to a {@link Denial}. */
export function toDenial(e: DeniedSandboxEvent): Denial {
  const d: Denial = {
    id: e.id,
    at: e.at,
    method: e.method,
    service: serviceOf(e),
    path: e.path ?? '(service)',
    auth: e.auth,
    reasons: e.reasons ?? [],
    origin: e.origin,
    unsupported: e.result === 'unsupported',
  };
  if ('matchedRule' in e && e.matchedRule) d.matchedRule = e.matchedRule;
  const requestData = requestDataOf(e);
  if (requestData !== undefined) d.resourceData = requestData;
  if (e.resourceBefore) d.resourceBefore = e.resourceBefore;
  return d;
}

/**
 * A human-readable explanation of *why* a denial fired, derived from the
 * simulator trace. This is the "rule that denied it" surface.
 *
 * `headline` is a one-line summary; `ruleLines` are the per-rule trace entries
 * (`Rule #N (ops) → deny`); `otherLines` are any remaining context lines the
 * simulator emitted (e.g. `get()` lookups, expression notes). `implicitDeny`
 * is true when NO rule matched at all: the most common beginner failure
 * ("you forgot to write an `allow` for this path").
 */
export interface RuleExplanation {
  headline: string;
  ruleLines: string[];
  otherLines: string[];
  implicitDeny: boolean;
}

const RULE_LINE = /^Rule #(\d+) \(([^)]+)\) → (ALLOW|deny|unsupported)/;

export function explainDenial(denial: Denial): RuleExplanation {
  const ruleLines = denial.reasons.filter((l) => RULE_LINE.test(l));
  const otherLines = denial.reasons.filter((l) => !RULE_LINE.test(l));
  const implicitDeny = !denial.matchedRule;

  let headline: string;
  if (denial.unsupported) {
    headline = `The simulator hit an unmodelled rules feature evaluating ${denial.method} ${denial.path}.`;
  } else if (denial.service !== 'firestore') {
    headline = `${denial.service} rules denied ${denial.method} on ${denial.path}.`;
  } else if (implicitDeny) {
    headline = `No rule allowed ${denial.method} on ${denial.path}: implicit deny (no matching \`allow\`).`;
  } else {
    const r = denial.matchedRule!;
    headline = `Rule #${r.ruleIndex} (${r.operations.join(', ')}) denied ${denial.method} on ${denial.path}.`;
  }

  return { headline, ruleLines, otherLines, implicitDeny };
}

/**
 * Severity ramp for a denial, mapping to the `--color-severity-*` token roles.
 * `unsupported` is the loudest (the sandbox couldn't even decide); a genuine
 * rule rejection is high; an implicit deny is medium (usually a missing rule,
 * not a security event). Listener-origin denials are low-key context.
 */
export type DenialSeverity = 'low' | 'medium' | 'high';

export function denialSeverity(denial: Denial): DenialSeverity {
  if (denial.unsupported) return 'high';
  if (denial.origin === 'listener') return 'low';
  if (!denial.matchedRule) return 'medium';
  return 'high';
}
