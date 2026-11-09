import { DataSnapshot, RtdbRuleRuntimeError, evaluateRtdbRule } from '../grammar/simulator.js';
import type { EvalContext, SimulatedAuth } from '../grammar/simulator.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';
import { SimulationInputSchema, simulationQueryProblem, type SimulationInput } from './spec.js';
import { normalizeAuthState } from '../../auth/auth-state.js';
import { withIdTokenClaims } from '../../auth/token-claims.js';
import { projectPostWriteTree } from './post-write-tree.js';
import type { RtdbRuleEvaluation, SimulateResult } from './spec.js';
import {
  childFor,
  findFailingValidate,
  toValidateFailureResult,
  traceEntry,
  wildcardChildOf,
  type ContextBuilder,
  type RuleOutcome,
  type TracedRuleEvaluator,
  type ValidateWalkInput,
} from './validate-walk.js';

export { wildcardChildOf };

/** One rule node on the way from the root to a path, with the `$variable` bindings that reach it. */
export interface AncestorMatch {
  node: RtdbNode;
  pathVariableBindings: Record<string, string>;
  /** Number of `path` segments consumed to reach this node from the root —
   *  i.e. this ancestor's own location, used to root `data`/`newData` at
   *  the rule's location rather than at the operation's target path. */
  depth: number;
}

/**
 * Evaluates one rule. A runtime error that production also raises, such as a
 * string method called on a number, fails the rule: a `.read` or `.write`
 * that raises one does not grant, and a `.validate` that raises one rejects
 * the write. Any other throw is a construct the simulator does not evaluate
 * and propagates to the caller.
 */
function evaluateRule(rule: RtdbRuleExpression, ctx: EvalContext): RuleOutcome {
  try {
    const result = evaluateRtdbRule(rule, ctx);
    if (typeof result !== 'boolean') {
      return { holds: false, runtimeError: 'Expression must evaluate to a boolean.' };
    }
    return { holds: result };
  } catch (error) {
    if (error instanceof RtdbRuleRuntimeError) return { holds: false, runtimeError: error.message };
    throw error;
  }
}

/**
 * The rules `auth` variable for a signed-in request: the uid, the ID token
 * claims with the tenant folded in by the shared normalizer, and `provider`,
 * which production reads as the token's `firebase.sign_in_provider`. There is
 * no top-level `auth.tenant`; production reads it as null.
 */
export function simulatedAuthOf(auth: NonNullable<SimulationInput['auth']>, nowMs: number): SimulatedAuth {
  const normalized = normalizeAuthState(auth);
  const token = withIdTokenClaims(auth.uid, normalized?.token ?? {}, nowMs);
  const simulated: SimulatedAuth = { uid: auth.uid, token };
  const firebase = token.firebase;
  const claims = typeof firebase === 'object' && firebase !== null ? (firebase as Record<string, unknown>) : {};
  const signInProvider = claims.sign_in_provider;
  if (typeof signInProvider === 'string') simulated.provider = signInProvider;
  return simulated;
}

function createTracedEvaluator(trace: RtdbRuleEvaluation[]): TracedRuleEvaluator {
  return (node, kind, rule, bindings, ctx) => {
    const outcome = evaluateRule(rule, ctx);
    trace.push(traceEntry(node, kind, rule, bindings, outcome));
    return outcome;
  };
}

/**
 * Walk from root toward the target path, collecting every ancestor node
 * along the way (including the deepest match). Firebase RTDB evaluates
 * rules from root down — a `true` at any ancestor grants access. The list
 * stops early, one node per segment matched, where no child rule applies.
 */
export function collectAncestors(
  node: RtdbNode,
  pathSegments: readonly string[],
  bindings: Record<string, string> = {},
  depth = 0,
): AncestorMatch[] {
  const ancestors: AncestorMatch[] = [{ node, pathVariableBindings: { ...bindings }, depth }];

  if (pathSegments.length === 0) return ancestors;

  const matched = childFor(node, pathSegments[0]!);
  if (matched === undefined) return ancestors;
  const newBindings = matched.variable === undefined
    ? { ...bindings }
    : { ...bindings, [matched.variable]: pathSegments[0]! };
  ancestors.push(...collectAncestors(matched.child, pathSegments.slice(1), newBindings, depth + 1));
  return ancestors;
}

/**
 * The rules `query` variable. A read reads the query it carries. A write
 * carries none, and production reads `query` in a `.write` or `.validate` as
 * it reads a plain read: `orderByKey` is `false` and every bound and limit is
 * null (capture rules-rtdb-r49-value-edges, SP-4).
 */
function buildSimulatedQueryContext(operation: string, readQuery: SimulationInput['query']): EvalContext['query'] {
  const query = operation === 'read' ? readQuery : undefined;
  const equalTo = query?.equalTo ?? null;
  return {
    orderByChild: query?.orderByChild ?? null,
    orderByKey: query?.orderByKey === true,
    orderByValue: query?.orderByValue === true,
    orderByPriority: query?.orderByPriority === true,
    equalTo,
    limitToFirst: query?.limitToFirst ?? null,
    limitToLast: query?.limitToLast ?? null,
    startAt: query?.startAt ?? equalTo,
    endAt: query?.endAt ?? equalTo,
  };
}

export class SimulateHandler {
  execute(compiled: RtdbNode, rawInput: unknown): SimulateResult {
    const parsed = SimulationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: parsed.error.message, recoverable: true },
      };
    }
    const queryProblem = parsed.data.query === undefined ? null : simulationQueryProblem(parsed.data.query);
    if (queryProblem !== null) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: queryProblem, recoverable: true },
      };
    }

    const { operation, path, auth, mockData, newData, updates, query } = parsed.data;
    // `now` in an RTDB rule is the instant the request is evaluated. A caller
    // hosting a sandbox names it so a `now`-gated rule moves with the sandbox
    // clock; a standalone caller leaves it out and gets the wall clock.
    const evaluationNow = parsed.data.now ?? Date.now();

    // Every rule evaluated for this request, in evaluation order.
    const trace: RtdbRuleEvaluation[] = [];

    try {
      const rawPathSegments = path.split('/').filter(Boolean);
      const pathSegments = rawPathSegments[rawPathSegments.length - 1] === '.priority'
        ? rawPathSegments.slice(0, -1)
        : rawPathSegments;
      const rootNode = compiled;

      const ancestors = collectAncestors(rootNode, pathSegments, {});

      // Walk from root down. First ancestor whose rule evaluates to true wins.
      //
      // `data`/`newData` must be rooted at EACH ancestor's own location —
      // not at the operation's target path — matching live RTDB semantics:
      // a rule declared at `/rooms/$roomId` sees `data`/`newData` as the
      // snapshot AT `/rooms/$roomId`, even when the write is deeper (e.g.
      // `/rooms/$roomId/title`). Rooting everything at the deepest write
      // path instead makes ancestor rules see "no data" (since the
      // deepest path usually doesn't exist yet), which silently satisfies
      // `!data.exists()`-style escape hatches and produces a false ALLOW.
      const evaluateTracedRule = createTracedEvaluator(trace);
      const rootData = new DataSnapshot(mockData, '/');
      // Post-write tree: mockData with the proposed write merged in. Reads
      // don't have a "post-write" state, so leave it as-is. For an atomic
      // multi-path `update()` (`updates` present) the projection reflects
      // EVERY path written together, so this path's rules see `newData` for
      // its sibling paths in the same update.
      let mergedRoot: unknown = mockData;
      if (operation !== 'read') {
        mergedRoot = projectPostWriteTree(mockData, path, rawPathSegments, newData, updates, evaluationNow);
      }
      const mergedRootData = new DataSnapshot(mergedRoot, '/');

      let contextAuth: SimulatedAuth | null = null;
      if (auth) contextAuth = simulatedAuthOf(auth, evaluationNow);

      const contextQuery = buildSimulatedQueryContext(operation, query);

      const buildContext: ContextBuilder = (data, newDataArg, bindings) => {
        const pvBindings: Record<string, string> = { ...bindings };
        return {
          auth: contextAuth,
          data,
          newData: newDataArg,
          root: rootData,
          now: evaluationNow,
          pathVariableBindings: pvBindings,
          query: contextQuery,
        };
      };
      const validateInput: ValidateWalkInput = {
        rootNode,
        rootData,
        mergedRootData,
        buildContext,
        evaluateTracedRule,
        trace,
        pathToWrite: pathSegments,
        updates,
      };

      // The validate operation runs only the `.validate` phase: every
      // `.validate` rule from the root through the write location and its
      // written descendants must pass, whatever `.write` grants.
      if (operation === 'validate') {
        const failure = findFailingValidate(validateInput);
        if (failure) return toValidateFailureResult(failure, trace);
        const lastValidated = trace[trace.length - 1];
        const deepestValidate = [...ancestors].reverse().find((a) => a.node.validate !== undefined);
        if (!lastValidated && !deepestValidate) {
          return {
            success: false,
            error: { code: 'NO_MATCHING_RULE', message: `No 'validate' rule found for path '${path}'`, recoverable: true },
          };
        }
        return {
          success: true,
          data: {
            allowed: true,
            matchedPath: lastValidated?.path ?? deepestValidate!.node.path,
            matchedRule: lastValidated?.conditionText ?? deepestValidate!.node.validate!.raw,
            reason: 'Validation rules evaluated to true',
            pathVariableBindings: lastValidated?.pathVariableBindings ?? deepestValidate!.pathVariableBindings,
            trace,
          },
        };
      }

      // Tracks the first ancestor whose `.write`/`.read` rule the grammar
      // couldn't parse. Unlike `.validate`, `.write`/`.read` rules cascade
      // (any ancestor granting `true` wins), so an unparseable rule is not
      // simply "no rule here" — production would still evaluate it and
      // might grant on it. If no ancestor grants and no real deny is
      // found either, this reported as `unsupported` rather than a
      // fabricated deny.
      let firstUnsupportedAncestor: AncestorMatch | undefined;
      // The runtime error each ancestor's rule raised, when it raised one. A
      // rule that raises one does not grant, and the cascade continues to the
      // next rule on the path, as it does after a rule that evaluates false.
      const runtimeErrors = new Map<AncestorMatch, string>();

      for (const ancestor of ancestors) {
        const ruleExpr: RtdbRuleExpression | undefined = ancestor.node[operation];
        if (!ruleExpr) continue;
        if (!ruleExpr.parsed.valid) {
          trace.push(traceEntry(ancestor.node, operation, ruleExpr, ancestor.pathVariableBindings, undefined));
          if (!firstUnsupportedAncestor) firstUnsupportedAncestor = ancestor;
          continue;
        }

        const ancestorSegments = pathSegments.slice(0, ancestor.depth).join('/');
        const dataAtAncestor = rootData.child(ancestorSegments);
        const newDataAtAncestor = mergedRootData.child(ancestorSegments);

        const outcome = evaluateTracedRule(
          ancestor.node,
          operation,
          ruleExpr,
          ancestor.pathVariableBindings,
          buildContext(dataAtAncestor, newDataAtAncestor, ancestor.pathVariableBindings),
        );
        if (outcome.runtimeError !== undefined) runtimeErrors.set(ancestor, outcome.runtimeError);

        if (outcome.holds) {
          // A granting `.write` is necessary but not sufficient: RTDB also
          // enforces every `.validate` rule from the root through the write
          // location and through every present descendant.
          // Unlike `.read`/`.write`, `.validate` does NOT cascade — all must
          // pass (a single failure denies the write). Read ops have no
          // validate phase.
          if (operation === 'write') {
            const failure = findFailingValidate(validateInput);
            if (failure) return toValidateFailureResult(failure, trace);
          }
          return {
            success: true,
            data: {
              allowed: true,
              matchedPath: ancestor.node.path,
              matchedRule: ruleExpr.raw,
              reason: 'Rule expression evaluated to true',
              pathVariableBindings: ancestor.pathVariableBindings,
              trace,
            },
          };
        }
      }

      // No ancestor rule evaluated to true. If an ancestor's rule couldn't
      // be parsed, we can't rule out that production would have granted on
      // it — report the gap instead of fabricating a deny.
      if (firstUnsupportedAncestor) {
        const rule = firstUnsupportedAncestor.node[operation] as RtdbRuleExpression;
        return {
          success: true,
          data: {
            allowed: false,
            unsupported: true,
            matchedPath: firstUnsupportedAncestor.node.path,
            matchedRule: rule.raw,
            reason: `'${operation}' rule at '${firstUnsupportedAncestor.node.path}' contains an expression the simulator cannot evaluate: ${rule.raw} — not evaluated; production may reject or allow this ${operation}.`,
            pathVariableBindings: firstUnsupportedAncestor.pathVariableBindings,
            trace,
          },
        };
      }

      // No rule on the path grants, so RTDB denies. The denial names the
      // deepest node that carries a rule of this kind, which may be an
      // ancestor of the deepest rules node on the path: that node can hold
      // only children, a `.validate`, or the other operation's rule. With no
      // rule of this kind anywhere on the path, the request is denied by
      // default and no node is named.
      const deciding = [...ancestors].reverse().find((a) => a.node[operation] !== undefined);
      if (deciding === undefined) {
        return {
          success: true,
          data: {
            allowed: false,
            matchedPath: '',
            matchedRule: '',
            reason: `No '${operation}' rule on '${path}' or its ancestors grants access; denied by default`,
            pathVariableBindings: ancestors[ancestors.length - 1]!.pathVariableBindings,
            trace,
          },
        };
      }
      const decidingRule = deciding.node[operation] as RtdbRuleExpression;
      const decidingError = runtimeErrors.get(deciding);
      const decidingOutcome = decidingError === undefined
        ? 'evaluated to false'
        : `failed at evaluation: ${decidingError}`;
      return {
        success: true,
        data: {
          allowed: false,
          matchedPath: deciding.node.path,
          matchedRule: decidingRule.raw,
          reason: `No '${operation}' rule grants access; the deepest, at '${deciding.node.path}', ${decidingOutcome}`,
          pathVariableBindings: deciding.pathVariableBindings,
          trace,
        },
      };
    } catch (e) {
      // A rule the evaluator does not evaluate, such as one calling a method
      // outside the rules language. Runtime errors that production also
      // raises never reach here: `evaluateRule` counts them as the rule failing.
      return {
        success: false,
        error: {
          code: 'EVALUATION_ERROR',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }
}
