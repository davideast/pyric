/**
 * Sandbox-layer error types: the error code union, the structured
 * denial-context payload, and the `SandboxError` class itself.
 */

import type { AuthState } from './auth-state.js';

/**
 * Error codes raised by the sandbox layer.
 *
 * The first batch matches Firebase / gRPC conventions so existing
 * `if (e.code === 'permission-denied')` code from production paths
 * keeps working. The second batch is sandbox-specific and exists so
 * agents can distinguish "sandbox doesn't simulate this" from "your
 * code is wrong" without parsing message strings.
 */
export type SandboxErrorCode =
  // Firebase-aligned
  | 'invalid-argument'
  | 'permission-denied'
  | 'not-found'
  | 'already-exists'
  | 'failed-precondition'
  | 'aborted'
  | 'unavailable'
  // Sandbox-specific
  | 'unimplemented'
  | 'not-seeded'
  | 'rules-not-loaded';

/**
 * Structured denial context emitted alongside a `permission-denied`
 * error. Real Firebase strips this server-side for security; the
 * sandbox can expose it because it's a development tool.
 *
 * `auth` and `reasons` are populated whenever the sandbox raises a
 * `permission-denied` error. `rule` (line + expression) requires
 * source-position tracking in the rules AST and is deferred — see
 * design rationale "Open questions" for the follow-up.
 * `failedFields` will be filled in once the evaluator surfaces field-
 * reference traces.
 */
export interface DenialContext {
  /** The rule whose evaluation produced the denial. Best effort; may be absent until source positions land in the AST. */
  rule?: { line: number; expression: string };
  /** Auth identity that was active when the denial fired. */
  auth?: AuthState;
  /** Field paths in `request.resource.data` that the rule referenced and that failed. */
  failedFields?: string[];
  /**
   * Raw simulator reasoning lines (the underlying engine's
   * `debugMessages`). Always present on `permission-denied`. Stable
   * enough for log surfacing; not stable as machine-parseable data.
   */
  reasons?: string[];
  /**
   * Eval-time request shape — what the rule saw on `request.*`. Lets
   * callers render a "why did this deny" frame (auth, method, path,
   * `request.resource.data` with sentinels resolved) without re-deriving
   * any of it from out-of-band state.
   */
  request?: {
    method: 'get' | 'list' | 'create' | 'update' | 'delete';
    path: string;
    /**
     * The user's proposed `request.resource.data` — pre-resolution.
     * `FieldValue.*` sentinels are preserved as their marker shapes
     * (`{ __type: 'serverTimestamp' }`, etc.). The rule engine
     * evaluated against the resolved form; what surfaces here is the
     * caller's INTENT so consumers see what they tried to write.
     * Absent for reads (no proposed write) and for `delete` (no payload).
     */
    resourceData?: Record<string, unknown>;
  };
  /**
   * Eval-time existing-document snapshot — what the rule saw on
   * `resource.data`. `null` data with `exists: false` mirrors how the
   * rule sees an absent doc. Absent for collection ops (`list`).
   */
  resource?: {
    data: Record<string, unknown> | null;
    exists: boolean;
  };
  /**
   * Machine-readable descriptor of the denied query's where/orderBy/limit
   * shape (RULES-B11). Populated when a `list`/query is denied as
   * statically unprovable ("rules are not filters"), so consumers can
   * render the exact query the engine rejected without re-deriving it.
   * Absent for single-doc and non-query denials.
   */
  query?: {
    readonly where?: readonly {
      readonly field: string;
      readonly op: string;
      readonly value: string | number | boolean | null;
    }[];
    readonly limit?: number | null;
    readonly offset?: number | null;
    readonly orderBy?: string | null;
  };
}

/**
 * Options bag for `SandboxError`. Used by call sites that want to
 * attach actionable remediation text (or both denial context and
 * remediation) without juggling positional argument order.
 */
export interface SandboxErrorOptions {
  code: SandboxErrorCode;
  message: string;
  denialContext?: DenialContext;
  /**
   * Optional human-readable guidance appended to the error's
   * `.message` so existing consumers that surface `error.message`
   * (logs, UIs) see the remediation without an API change. Stored on
   * the instance as well so structured callers can read it directly.
   */
  remediation?: string;
}

/**
 * Sandbox-layer error. Catch with `instanceof SandboxError` and switch
 * on `code`. `denialContext` is populated for `permission-denied` only
 * (and only after Slice 4 wires it through).
 *
 * Two construction forms are supported:
 *   - Positional: `new SandboxError(code, message, denialContext?)` —
 *     the original signature, kept for backward compatibility with
 *     existing internal call sites.
 *   - Options bag: `new SandboxError({ code, message, remediation? })` —
 *     used when attaching remediation guidance.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly denialContext?: DenialContext;
  readonly remediation?: string;

  constructor(code: SandboxErrorCode, message: string, denialContext?: DenialContext);
  constructor(options: SandboxErrorOptions);
  constructor(
    codeOrOptions: SandboxErrorCode | SandboxErrorOptions,
    message?: string,
    denialContext?: DenialContext,
  ) {
    const isOptions = typeof codeOrOptions === 'object';
    const code = isOptions ? codeOrOptions.code : codeOrOptions;
    const baseMessage = isOptions ? codeOrOptions.message : (message as string);
    const ctx = isOptions ? codeOrOptions.denialContext : denialContext;
    const remediation = isOptions ? codeOrOptions.remediation : undefined;
    const fullMessage =
      remediation !== undefined
        ? `${baseMessage}\n\nRemediation:\n${remediation}`
        : baseMessage;
    super(fullMessage);
    this.name = 'SandboxError';
    this.code = code;
    if (ctx !== undefined) {
      this.denialContext = ctx;
    }
    if (remediation !== undefined) {
      this.remediation = remediation;
    }
  }
}
