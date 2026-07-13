/**
 * RTDB rules evaluation — adapter from the modular SDK's sandbox
 * backend to the existing internal RTDB simulator.
 *
 * The hard part of an RTDB sandbox is the rules engine; the package
 * already ships one (`SimulateHandler` + the Ohm grammar). This module
 * is the thin glue that lets a path-based read / write op consult that
 * engine without the modular backend needing to know about IR shapes.
 *
 * Permission semantics mirror the empirical oracle observations
 * (`rtdb-rules-denied-error-code.json`):
 *   - On denial: throw a plain `Error` (NOT a `FirebaseError`).
 *   - `.code === 'PERMISSION_DENIED'` (uppercase snake-case — distinct
 *     from Firestore's lowercase `'permission-denied'`).
 *   - `.message === 'PERMISSION_DENIED: Permission denied'`.
 *
 * Default-allow stance: if no rules have been deployed, every operation
 * is permitted. Matches the live RTDB default for projects whose rules
 * have never been written (the console's "Start in test mode" template
 * is `{ ".read": "auth != null", ".write": "auth != null" }`; an
 * unconfigured DB allows everything until rules deploy).
 */
import { RtdbMapper } from '../../rules/rtdb/mapper.js';
import { SimulateHandler } from '../../rules/rtdb/simulation/handler.js';
import type { RtdbIR } from '../../rules/rtdb/types.js';
import type { AuthState } from 'pyric/sandbox';

/**
 * Plain-Error denial constructor. Matches the oracle observation: the
 * thrown value's `.name === 'Error'`, `.constructor.name === 'Error'`,
 * `.code === 'PERMISSION_DENIED'`, `.message === 'PERMISSION_DENIED: Permission denied'`.
 *
 * Using a one-off constructor instead of a subclass keeps
 * `error.constructor.name === 'Error'` — which is what the live
 * `firebase/database` SDK does. A `class PermissionDeniedError extends Error`
 * would leak its name and break the oracle's shape claim.
 */
export function permissionDenied(): Error {
  const err = new Error('PERMISSION_DENIED: Permission denied') as Error & { code: string };
  err.code = 'PERMISSION_DENIED';
  return err;
}

/**
 * Wrapper around the existing `SimulateHandler` that:
 *   - parses freshly-deployed rules JSON into an IR (cached per
 *     `RulesEvaluator` instance);
 *   - exposes a `check(op, path, auth, mockData?, newData?)` that
 *     returns `'allow' | 'deny' | 'no-rule'`.
 *
 * `'no-rule'` is treated as deny by callers in the user-mode path,
 * matching RTDB's implicit-deny default ("nothing matched → no
 * permission"). The wrapper itself stays neutral so admin-mode callers
 * (which bypass rules entirely) can use a different fold.
 *
 * `'unsupported'` is a distinct third outcome: the simulator hit a rule
 * expression it cannot parse/evaluate and abstained rather than granting
 * or denying. It is folded to deny by user-mode callers (same as
 * `'no-rule'` — abstain, never grant) but reported separately on the
 * event stream so Studio's traffic view can show it as a simulator gap
 * instead of a real rules decision. Matches the Firestore simulator's
 * posture: `UNSUPPORTED` never counts as a real evaluation and never
 * grants access.
 */
export type RuleCheck = 'allow' | 'deny' | 'no-rule' | 'unsupported';

export interface RuleEvaluationDetails {
  check: RuleCheck;
  reasons: string[];
  matchedPath?: string;
  matchedRule?: string;
  reason?: string;
  pathVariableBindings?: Record<string, string>;
  errorCode?: string;
  errorMessage?: string;
}

export interface EvalContext {
  /** Identity for `request.auth`. `null` is anonymous. */
  auth: AuthState;
  /** Snapshot the rules engine sees as `data` / `root.child(...)`.
   *  Pass the current tree (or a relevant subtree); the simulator
   *  walks via path-relative lookups. */
  mockData: Record<string, unknown>;
  /** Proposed value at `path` for write/validate ops. Ignored for read. */
  newData?: unknown;
  /**
   * All paths written together in one atomic multi-path `update()`. When
   * set, the simulator projects every listed path onto a single post-write
   * tree so `path`'s rules see `newData` reflecting its sibling paths in the
   * same update. Omit for single-path writes.
   */
  updates?: { path: string; value: unknown }[];
}

export class RulesEvaluator {
  private ir: RtdbIR | null = null;
  private readonly handler = new SimulateHandler();

  /** Replace the deployed rules. `null` clears (sandbox returns to
   *  default-allow). */
  setRules(rulesJson: { rules: Record<string, unknown> } | null): void {
    if (rulesJson === null) {
      this.ir = null;
      return;
    }
    // shallowData is irrelevant here — used only by the IR for crawl
    // metadata. Pass null so we don't synthesize fake-exists flags.
    this.ir = RtdbMapper.mapToIR(rulesJson, null, 'sandbox://rtdb');
  }

  /** True when rules have been deployed via `setRules`. */
  hasRules(): boolean {
    return this.ir !== null;
  }

  /**
   * Evaluate one op. Default-allow when no rules are loaded.
   *
   * Errors from the underlying simulator (grammar mismatches, etc.)
   * surface as `'no-rule'` — they're treated as deny by user-mode
   * callers, which is the safe default for "we couldn't decide". The
   * simulator already returns success-shaped results for true/false
   * outcomes; failures here mean we genuinely can't reason about the
   * rule.
   */
  check(
    operation: 'read' | 'write' | 'validate',
    path: string,
    ctx: EvalContext,
  ): RuleCheck {
    return this.evaluate(operation, path, ctx).check;
  }

  evaluate(
    operation: 'read' | 'write' | 'validate',
    path: string,
    ctx: EvalContext,
  ): RuleEvaluationDetails {
    if (this.ir === null) {
      return {
        check: 'allow',
        reasons: ['No RTDB rules loaded; default allow.'],
      };
    }
    // The simulator's SimulationInputSchema requires `auth` to be
    // either `null` or `{ uid: string, token: Record<string, unknown> }` —
    // `token` is mandatory, not optional. `AuthState` from
    // `pyric/sandbox` makes `token` optional. Normalise here so an
    // auth identity without custom claims (`{ uid: 'alice' }`) still
    // satisfies the schema and the rule sees `auth.token = {}`.
    const normalisedAuth =
      ctx.auth === null
        ? null
        : { uid: ctx.auth.uid, token: ctx.auth.token ?? {} };
    const result = this.handler.execute(this.ir, {
      operation,
      path: path === '/' ? '/' : path,
      auth: normalisedAuth,
      mockData: ctx.mockData,
      newData: ctx.newData,
      updates: ctx.updates,
    });
    if (!result.success) {
      if (result.error.code === 'NO_MATCHING_RULE') {
        return {
          check: 'no-rule',
          reasons: [result.error.message],
          errorCode: result.error.code,
          errorMessage: result.error.message,
        };
      }
      // INVALID_INPUT / IR_NOT_GENERATED / EVALUATION_ERROR — treat as
      // no-rule (user-mode callers fold to deny).
      return {
        check: 'no-rule',
        reasons: [result.error.message],
        errorCode: result.error.code,
        errorMessage: result.error.message,
      };
    }
    if (result.data.unsupported) {
      return {
        check: 'unsupported',
        reasons: [`${result.data.matchedPath} ${operation} UNSUPPORTED: ${result.data.reason}`],
        matchedPath: result.data.matchedPath,
        matchedRule: result.data.matchedRule,
        reason: result.data.reason,
        pathVariableBindings: result.data.pathVariableBindings,
      };
    }
    return {
      check: result.data.allowed ? 'allow' : 'deny',
      reasons: [
        `${result.data.matchedPath} ${operation} ${result.data.allowed ? 'ALLOW' : 'DENY'}: ${result.data.reason}`,
      ],
      matchedPath: result.data.matchedPath,
      matchedRule: result.data.matchedRule,
      reason: result.data.reason,
      pathVariableBindings: result.data.pathVariableBindings,
    };
  }
}
