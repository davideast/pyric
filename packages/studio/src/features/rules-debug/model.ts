/**
 * Rules-failure debugging: the pure view-model (Pyric Studio F4).
 *
 * Prose spec (what this page shows per service, grounded in each service's
 * mechanical rules tooling, and exactly where a capability is gated off) lives
 * in the colocated `SPEC.md` — read that first.
 *
 * Everything here is a PURE function over the unified event stream
 * ({@link SandboxEvent}), no React, no worker, no DOM. The UI (`RulesDebug.tsx`)
 * renders these shapes; the re-run actions (`rerun.ts`) consume a {@link Denial}.
 * Factoring the denial→rule→context derivation out as data makes it unit-testable
 * without a browser (see `rules-debug.test.ts`).
 */

import type {
  AuthState,
  RequestEvent,
  SandboxEvent,
  SandboxOperationEvent,
} from 'pyric/sandbox';

type DeniedSandboxEvent = RequestEvent | SandboxOperationEvent;

/** The rule-engine verdict a service's mechanical simulator/enforcer stamped on
 *  the operation event. Mirrors {@link SandboxOperationEvent.rules} verbatim (do
 *  not invent a parallel shape). Present on RTDB denials today; Firestore keeps
 *  its per-rule trace on `reasons`/`matchedRule`; Storage will populate it once
 *  a storage denial-event emitter lands. */
export type RuleVerdict = NonNullable<SandboxOperationEvent['rules']>;

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
  /** The rule that denied, parsed from the simulator trace (Firestore). Absent
   *  when no rule even tried to match (implicit deny: no `allow` at the path). */
  matchedRule?: { ruleIndex: number; operations: string[] };
  /** The service rules engine's structured verdict (RTDB `.write`/`.validate`
   *  node, matched path, bindings, reason). Absent for Firestore (whose trace
   *  lives in `reasons`/`matchedRule`) and for any denial that arrived on a
   *  legacy `RequestEvent`. */
  rules?: RuleVerdict;
  /** Raw simulator/enforcer trace lines (Firestore `Rule #N (ops) → deny`;
   *  RTDB `${path} write DENY: …`; Storage `match /… verb: condition false`). */
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
  if ('rules' in e && e.rules) d.rules = e.rules;
  const requestData = requestDataOf(e);
  if (requestData !== undefined) d.resourceData = requestData;
  if (e.resourceBefore) {
    d.resourceBefore = {
      data: e.resourceBefore.data,
      exists: e.resourceBefore.exists,
    };
  }
  return d;
}

// ─── Per-service explanation ────────────────────────────────────────────────

/** Which mechanical rules engine produced a denial. */
export type RuleEngine = 'firestore' | 'rtdb' | 'storage';

/** For RTDB, WHICH rule phase denied — the `.read`/`.write` gate, or a
 *  non-cascading `.validate` on the proposed value. */
export type RulePhase = 'read' | 'write' | 'validate';

/**
 * A human-readable explanation of *why* a denial fired, grounded in the
 * emitting service's mechanical rules engine.
 *
 * `headline` is a one-line summary; the per-service fields carry the tool-grounded
 * detail the UI renders:
 *   - `engine`     which rules engine decided (firestore/rtdb/storage).
 *   - `ruleNode`   the denying node in that engine's own terms: Firestore
 *                  `Rule #N (ops)`, RTDB `${matchedPath} .write|.validate|.read`,
 *                  Storage `match /… verb`. Absent on an implicit deny.
 *   - `ruleExpression` the raw rule text that evaluated false (RTDB `matchedRule`).
 *   - `phase`      RTDB only — `.read`/`.write` gate vs `.validate`.
 *   - `bindings`   RTDB path-variable bindings ($roomId → r1).
 *   - `ruleLines`  Firestore per-rule trace entries (`Rule #N (ops) → deny`).
 *   - `otherLines` remaining trace/context lines (get() lookups, notes).
 *   - `implicitDeny` no rule matched at all — the "you forgot an `allow`" case,
 *                  service-aware (Firestore: no `matchedRule`; RTDB:
 *                  `NO_MATCHING_RULE` / no `matchedPath`; Storage: `no rule
 *                  matches`).
 */
export interface RuleExplanation {
  headline: string;
  engine: RuleEngine;
  ruleNode?: string;
  ruleExpression?: string;
  phase?: RulePhase;
  bindings?: Record<string, string>;
  ruleLines: string[];
  otherLines: string[];
  implicitDeny: boolean;
}

const RULE_LINE = /^Rule #(\d+) \(([^)]+)\) → (ALLOW|deny|unsupported)/;

/** Normalise a denial's service to one of the three rules engines. Unknown
 *  services (or `auth`, which has no security rules) fall back to firestore-style
 *  presentation, which is trace-only and safe. */
function engineOf(denial: Denial): RuleEngine {
  const e = denial.rules?.engine ?? denial.service;
  return e === 'rtdb' || e === 'storage' ? e : 'firestore';
}

/** RTDB rule phase for a denial: a `.validate` failure (from the mechanical
 *  `reason`) beats the method-derived read/write gate. */
function rtdbPhase(denial: Denial): RulePhase {
  if (denial.rules?.reason === 'Validation rule evaluated to false') return 'validate';
  const m = denial.method;
  return m === 'get' || m === 'list' || m === 'listen' ? 'read' : 'write';
}

export function explainDenial(denial: Denial): RuleExplanation {
  const engine = engineOf(denial);
  const ruleLines = denial.reasons.filter((l) => RULE_LINE.test(l));
  const otherLines = denial.reasons.filter((l) => !RULE_LINE.test(l));

  if (denial.unsupported) {
    return {
      headline: `The simulator hit an unmodelled rules feature evaluating ${denial.method} ${denial.path}.`,
      engine,
      ruleLines,
      otherLines,
      implicitDeny: false,
    };
  }

  if (engine === 'rtdb') return explainRtdb(denial, ruleLines, otherLines);
  if (engine === 'storage') return explainStorage(denial, ruleLines, otherLines);
  return explainFirestore(denial, ruleLines, otherLines);
}

/** Firestore: grounded in the simulator's `Rule #N` trace + `matchedRule`. */
function explainFirestore(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const implicitDeny = !denial.matchedRule;
  let headline: string;
  let ruleNode: string | undefined;
  if (implicitDeny) {
    headline = `No rule allowed ${denial.method} on ${denial.path}: implicit deny (no matching \`allow\`).`;
  } else {
    const r = denial.matchedRule!;
    ruleNode = `Rule #${r.ruleIndex} (${r.operations.join(', ')})`;
    headline = `${ruleNode} denied ${denial.method} on ${denial.path}.`;
  }
  return { headline, engine: 'firestore', ruleNode, ruleLines, otherLines, implicitDeny };
}

/** RTDB: grounded in `SimulateHandler`'s verdict — the `.write`/`.validate` node
 *  at `matchedPath`, its raw expression, and the path-variable bindings. */
function explainRtdb(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const rules = denial.rules;
  const phase = rtdbPhase(denial);
  const implicitDeny = !rules?.matchedPath || rules?.errorCode === 'NO_MATCHING_RULE';
  const bindings =
    rules?.pathVariableBindings && Object.keys(rules.pathVariableBindings).length > 0
      ? rules.pathVariableBindings
      : undefined;

  let headline: string;
  let ruleNode: string | undefined;
  if (implicitDeny) {
    headline = `No \`.${phase}\` rule granted ${denial.method} on ${denial.path}: RTDB implicit deny (no rule matched).`;
  } else if (phase === 'validate') {
    ruleNode = `${rules!.matchedPath} .validate`;
    headline = `The \`.validate\` rule at \`${rules!.matchedPath}\` rejected the proposed value for ${denial.method} ${denial.path}.`;
  } else {
    ruleNode = `${rules!.matchedPath} .${phase}`;
    headline = `The \`.${phase}\` rule at \`${rules!.matchedPath}\` evaluated false for ${denial.method} ${denial.path}.`;
  }

  return {
    headline,
    engine: 'rtdb',
    ruleNode,
    ruleExpression: rules?.matchedRule,
    phase,
    bindings,
    ruleLines,
    otherLines,
    implicitDeny,
  };
}

/** Storage: grounded in `evaluateStorageRules`' reasons — the `match` block whose
 *  `allow` condition was false, or the no-rule-matched implicit deny. */
function explainStorage(
  denial: Denial,
  ruleLines: string[],
  otherLines: string[],
): RuleExplanation {
  const matchLine = denial.reasons.find((l) => /^match\s/.test(l));
  const noRule = denial.reasons.some((l) => /^no rule matches/.test(l));
  const implicitDeny = noRule || !matchLine;

  const headline = implicitDeny
    ? `No \`match\` block allowed ${denial.method} on ${denial.path}: Storage implicit deny (no rule matched).`
    : `A \`match\` block condition evaluated false for ${denial.method} on ${denial.path}.`;

  return {
    headline,
    engine: 'storage',
    ruleNode: implicitDeny ? undefined : matchLine,
    ruleLines,
    otherLines,
    implicitDeny,
  };
}

// ─── Re-run capability, per service ─────────────────────────────────────────

/**
 * Whether a re-run path is backed by a real mechanical tool, and if so which.
 *   - `live`     a tool backs it AND the host can wire it now (Firestore).
 *     Enable the control when the matching callback is supplied; otherwise the UI
 *     shows the standard "needs the live backend" hint.
 *   - `pending`  the mechanical tool EXISTS but the Studio worker hasn't wired it
 *     for this service — render disabled, hint naming `tool`.
 *   - `absent`   no mechanical tool exists for this path yet — render disabled,
 *     hint naming the `missingTool` (roadmap signal, not a bug).
 */
export type RerunSupport =
  | { kind: 'live'; tool: string }
  | { kind: 'pending'; tool: string; hint: string }
  | { kind: 'absent'; missingTool: string; hint: string };

export interface ServiceRerunSupport {
  /** Re-issue the denied op AS the attempting user (impersonation). */
  impersonate: RerunSupport;
  /** Re-run against an edited ruleset (fork + lint + simulate + diff). */
  editedRuleset: RerunSupport;
}

/**
 * The re-run capability for a denial's service, grounded in what each service's
 * rules tooling actually offers today (see `SPEC.md`). Pure over the denial's
 * `service` — the UI combines this with callback presence to decide enabled vs
 * disabled-with-hint.
 */
export function rerunSupport(denial: Denial): ServiceRerunSupport {
  switch (engineOf(denial)) {
    case 'firestore':
      return {
        impersonate: {
          kind: 'live',
          tool: "worker setLens({mode:'as',uid}) → Firestore replay",
        },
        editedRuleset: {
          kind: 'live',
          tool: 'fork + firestore_lint_rules + firestore_simulate_rules',
        },
      };
    case 'rtdb':
      return {
        impersonate: {
          kind: 'pending',
          tool: 'rtdb_simulate_access',
          hint: 'RTDB re-runs through the local rules simulator as this user once the Studio worker exposes rtdb_simulate_access. This is a simulation, not a live re-issue — RTDB has no live local enforcement path.',
        },
        editedRuleset: {
          kind: 'pending',
          tool: 'RulesEvaluator.setRules + rtdb_simulate_access',
          hint: 'Editing the RTDB ruleset re-simulates the write once the worker exposes the RTDB simulator. Note: there is no whole-ruleset RTDB linter yet (rtdb_build_expression lints a single expression).',
        },
      };
    case 'storage':
      return {
        impersonate: {
          kind: 'absent',
          missingTool: 'storage_simulate_rules',
          hint: 'Storage rule evaluation (enforceRules / evaluateStorageRules) is internal — no storage_simulate_rules tool exists to re-run a denial as a user.',
        },
        editedRuleset: {
          kind: 'absent',
          missingTool: 'storage_simulate_rules + a storage denial event',
          hint: 'Storage denials do not yet emit an operation event with rules.engine="storage", and there is no storage rules simulate/lint tool to fork against. Storage rules also aren\'t enforced in the served sandbox yet.',
        },
      };
  }
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
  if (explainDenial(denial).implicitDeny) return 'medium';
  return 'high';
}
