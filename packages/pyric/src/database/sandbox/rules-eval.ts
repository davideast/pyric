/**
 * RTDB rules evaluation — adapter from the modular SDK's sandbox
 * backend to the existing internal RTDB simulator.
 *
 * The hard part of an RTDB sandbox is the rules engine; the package
 * already ships one (the compiled-rules seam plus the Ohm grammar). This module
 * is the thin glue that lets a path-based read / write op consult that
 * engine without the modular backend needing to know its compiled tree shape.
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
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
} from '../../rules/rtdb/compiled-rules.js';
import type { SimulationInput } from '../../rules/rtdb/simulation/spec.js';
import type { AuthState } from 'pyric/sandbox';
import { SandboxClock } from 'pyric/sandbox';
import type { QuerySpec } from './query.js';

function toPrimitiveBoundValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function resolveRequiredIndexKey(
  orderBy: { kind: 'child'; path: string } | { kind: 'value' },
): string {
  if (orderBy.kind === 'value') {
    return '.value';
  }
  return orderBy.path.split('/').filter(Boolean).join('/');
}

/**
 * Convert a sandbox `QuerySpec` to the `SimulationInput['query']` shape
 * consumed by the RTDB rules simulator.
 */
export function querySpecToSimulationQuery(spec: QuerySpec): SimulationInput['query'] {
  const q: NonNullable<SimulationInput['query']> = {};
  if (spec.orderBy?.kind === 'child') {
    q.orderByChild = spec.orderBy.path;
  } else if (spec.orderBy?.kind === 'key') {
    q.orderByKey = true;
  } else if (spec.orderBy?.kind === 'value') {
    q.orderByValue = true;
  }
  for (const bound of spec.bounds) {
    const val = toPrimitiveBoundValue(bound.value);
    if (bound.kind === 'equalTo') {
      q.equalTo = val;
      q.startAt = val;
      q.endAt = val;
    } else if (bound.kind === 'startAt' || bound.kind === 'startAfter') {
      q.startAt = val;
    } else if (bound.kind === 'endAt' || bound.kind === 'endBefore') {
      q.endAt = val;
    }
  }
  if (spec.limit?.kind === 'limitToFirst') {
    q.limitToFirst = spec.limit.n;
  } else if (spec.limit?.kind === 'limitToLast') {
    q.limitToLast = spec.limit.n;
  }
  return q;
}

function findMatchingNodesAtPath(root: CompiledRtdbRules, segments: string[]): CompiledRtdbRules[] {
  let currentNodes: CompiledRtdbRules[] = [root];
  for (const seg of segments) {
    const nextNodes: CompiledRtdbRules[] = [];
    for (const node of currentNodes) {
      for (const child of node.children) {
        const childSegs = child.path.split('/').filter(Boolean);
        const lastSeg = childSegs[childSegs.length - 1];
        if (!lastSeg) continue;
        if (lastSeg === seg || lastSeg.startsWith('$')) {
          nextNodes.push(child);
        }
      }
    }
    currentNodes = nextNodes;
    if (currentNodes.length === 0) break;
  }
  return currentNodes;
}

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
 * Wrapper around the pure rules engine that:
 *   - compiles freshly-deployed rules JSON into a tree (cached per
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
  /** Optional query constraints for read rule evaluation. */
  query?: SimulationInput['query'];
  /** Optional query spec from sandbox query execution; automatically converts to `query` and validates `.indexOn`. */
  querySpec?: QuerySpec;
}

export type RtdbDefaultPolicy = 'allow' | 'deny';

export class RulesEvaluator {
  private compiled: CompiledRtdbRules | null = null;
  private defaultPolicy: RtdbDefaultPolicy = 'deny';

  /**
   * @param clock The sandbox's clock, read for the rules engine's `now`. A
   * standalone evaluator keeps its own wall clock.
   */
  constructor(private readonly clock: SandboxClock = new SandboxClock()) {}

  /** Set default access policy when no rules are loaded ('allow' or 'deny'). */
  setDefaultPolicy(policy: RtdbDefaultPolicy): void {
    this.defaultPolicy = policy;
  }

  /** Replace the deployed rules. `null` clears (sandbox returns to
   *  configured default policy). */
  setRules(rulesJson: { rules: Record<string, unknown> } | null): void {
    if (rulesJson === null) {
      this.compiled = null;
      return;
    }
    this.compiled = compileRtdbRules(rulesJson);
  }

  /** True when rules have been deployed via `setRules`. */
  hasRules(): boolean {
    return this.compiled !== null;
  }

  /**
   * Enforce `.indexOn` rules for queries when security rules are active.
   *
   * Built-in orderings (`orderByKey`, `orderByPriority`, or default priority)
   * and queries when no security rules are loaded (`this.compiled === null`)
   * are exempt.
   */
  assertQueryIndex(path: string, spec: QuerySpec): void {
    if (this.compiled === null) return;
    if (spec.orderBy === null) return;
    if (spec.orderBy.kind === 'key' || spec.orderBy.kind === 'priority') return;

    const requiredIndex = resolveRequiredIndexKey(spec.orderBy);

    const segments = path.split('/').filter(Boolean);
    const normalizedPath = '/' + segments.join('/');

    const matchingNodes = findMatchingNodesAtPath(this.compiled, segments);
    const hasIndex = matchingNodes.some((node) =>
      node.indexOn?.some(
        (idx) => idx === requiredIndex || idx.split('/').filter(Boolean).join('/') === requiredIndex,
      ),
    );

    if (!hasIndex) {
      throw new Error(
        `Index not defined, add ".indexOn": "${requiredIndex}", for path "${normalizedPath}", to the rules`,
      );
    }
  }

  /**
   * Evaluate one op. Default-deny when no rules are loaded.
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
    const isReadOperation = operation === 'read';
    if (isReadOperation) {
      const isRootInfoPath = path === '/.info' || path === '.info';
      if (isRootInfoPath) {
        return {
          check: 'allow',
          reasons: ['/.info/ system metadata paths are always readable regardless of security rules.'],
        };
      }
      const startsWithSlashInfo = path.startsWith('/.info/');
      if (startsWithSlashInfo) {
        return {
          check: 'allow',
          reasons: ['/.info/ system metadata paths are always readable regardless of security rules.'],
        };
      }
      const startsWithDotInfo = path.startsWith('.info/');
      if (startsWithDotInfo) {
        return {
          check: 'allow',
          reasons: ['/.info/ system metadata paths are always readable regardless of security rules.'],
        };
      }
    }
    if (this.compiled === null) {
      if (this.defaultPolicy === 'deny') {
        return {
          check: 'no-rule',
          reasons: ['No RTDB rules loaded; default deny.'],
          errorCode: 'NO_MATCHING_RULE',
          errorMessage: 'No RTDB rules loaded; default deny.',
        };
      }
      return {
        check: 'allow',
        reasons: ['No RTDB rules loaded; default allow.'],
      };
    }
    // The simulator's SimulationInputSchema accepts `auth` as
    // either `null` or `{ uid: string, tenant?: string, token?: Record<string, unknown> }`.
    // Preserve tenant and optional token from AuthState so tenant claim
    // normalization and custom claims reach the simulator.
    let normalisedAuth: SimulationInput['auth'] = null;
    if (ctx.auth !== null) {
      normalisedAuth = {
        uid: ctx.auth.uid,
        token: ctx.auth.token ?? {},
      };
      if (ctx.auth.tenant !== undefined) {
        normalisedAuth.tenant = ctx.auth.tenant;
      }
    }
    let simulatedQuery = ctx.query;
    if (simulatedQuery === undefined && ctx.querySpec !== undefined) {
      simulatedQuery = querySpecToSimulationQuery(ctx.querySpec);
    }
    const result = simulateRtdbRules(this.compiled, {
      operation,
      path: path === '/' ? '/' : path,
      auth: normalisedAuth,
      mockData: ctx.mockData,
      newData: ctx.newData,
      updates: ctx.updates,
      query: simulatedQuery,
      now: this.clock.now(),
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
      // INVALID_INPUT / EVALUATION_ERROR — treat as
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
    if (result.data.allowed && isReadOperation && ctx.querySpec) {
      this.assertQueryIndex(path, ctx.querySpec);
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
