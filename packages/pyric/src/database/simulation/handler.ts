import { grammar } from '../grammar/RtdbExprParser.js';
import { DataSnapshot, evaluateExpression } from '../grammar/simulator.js';
import type { EvalContext } from '../grammar/simulator.js';
import type { RtdbIR, RtdbNode, RtdbRuleExpression } from '../types.js';
import { SimulationInputSchema } from './spec.js';
import type { SimulateResult } from './spec.js';

interface AncestorMatch {
  node: RtdbNode;
  pathVariableBindings: Record<string, string>;
}

/** Builds the evaluation context for a rule at a given node — supplied by
 *  `execute` so it can close over `auth` / `root` / the requested op. */
type ContextBuilder = (
  data: DataSnapshot,
  newData: DataSnapshot,
  bindings: Record<string, string>,
) => EvalContext;

interface ValidateFailure {
  node: RtdbNode;
  rule: RtdbRuleExpression;
  bindings: Record<string, string>;
}

/** Own-enumerable keys of a snapshot's object value; empty for non-objects. */
function snapshotChildKeys(snap: DataSnapshot): string[] {
  const value = snap.val();
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value as object);
}

/**
 * Descend the rule tree to the node sitting exactly at the write location,
 * accumulating `$pathVar` bindings along the way. Returns `null` when the
 * write path runs deeper than the rule tree — i.e. there is no rule node
 * at or below the write location, so nothing to validate. (Mirrors
 * {@link collectAncestors}' first-match descent so bindings stay
 * consistent.)
 */
function findWriteLocationNode(
  node: RtdbNode,
  segments: string[],
  bindings: Record<string, string>,
): { node: RtdbNode; bindings: Record<string, string> } | null {
  if (segments.length === 0) return { node, bindings };

  for (const child of node.children) {
    const childSegments = child.path.split('/').filter(Boolean);
    if (childSegments.length === 0) continue;

    const lastSegment = childSegments[childSegments.length - 1];
    const isPathVar = lastSegment.startsWith('$');

    if (isPathVar || segments[0] === lastSegment) {
      const newBindings = isPathVar
        ? { ...bindings, [lastSegment]: segments[0] }
        : { ...bindings };
      return findWriteLocationNode(child, segments.slice(1), newBindings);
    }
  }

  return null;
}

/**
 * Non-cascading `.validate` enforcement for a write. RTDB evaluates
 * `.validate` on the post-write value at the write location and at every
 * descendant present in that value; unlike `.read`/`.write` these rules do
 * NOT cascade — ALL must evaluate true, and a single failure denies the
 * whole write. Nodes whose proposed value is null (a delete) are skipped,
 * and an unparseable `.validate` expression is skipped rather than denied
 * (never flip a prod-legal write to a sandbox denial over a rule the
 * grammar can't reason about). Ancestor `.validate` rules ABOVE the write
 * location are not evaluated. Returns the first failing node, or `null`
 * when every applicable `.validate` passes.
 */
function findFailingValidate(
  node: RtdbNode,
  data: DataSnapshot,
  newData: DataSnapshot,
  bindings: Record<string, string>,
  buildContext: ContextBuilder,
): ValidateFailure | null {
  // A null proposed value is a delete — RTDB does not validate deletes.
  if (!newData.exists()) return null;

  const rule = node.validate;
  if (rule && rule.parsed.valid) {
    const match = grammar.match(rule.raw.trim());
    const result = evaluateExpression(match, buildContext(data, newData, bindings));
    if (!result) return { node, rule, bindings };
  }

  for (const child of node.children) {
    const childSegments = child.path.split('/').filter(Boolean);
    if (childSegments.length === 0) continue;

    const lastSegment = childSegments[childSegments.length - 1];
    const isPathVar = lastSegment.startsWith('$');

    if (isPathVar) {
      // Bind the path variable to each key actually present in the new
      // data — a `$var` node validates every child of the written value.
      for (const key of snapshotChildKeys(newData)) {
        const failure = findFailingValidate(
          child,
          data.child(key),
          newData.child(key),
          { ...bindings, [lastSegment]: key },
          buildContext,
        );
        if (failure) return failure;
      }
    } else {
      const failure = findFailingValidate(
        child,
        data.child(lastSegment),
        newData.child(lastSegment),
        bindings,
        buildContext,
      );
      if (failure) return failure;
    }
  }

  return null;
}

/**
 * Walk from root toward the target path, collecting every ancestor node
 * along the way (including the deepest match). Firebase RTDB evaluates
 * rules from root down — a `true` at any ancestor grants access.
 */
function collectAncestors(
  node: RtdbNode,
  pathSegments: string[],
  bindings: Record<string, string>,
): AncestorMatch[] {
  const ancestors: AncestorMatch[] = [{ node, pathVariableBindings: { ...bindings } }];

  if (pathSegments.length === 0) return ancestors;

  for (const child of node.children) {
    const childSegments = child.path.split('/').filter(Boolean);
    if (childSegments.length === 0) continue;

    const lastSegment = childSegments[childSegments.length - 1];
    const isPathVar = lastSegment.startsWith('$');

    if (isPathVar || pathSegments[0] === lastSegment) {
      const newBindings = isPathVar
        ? { ...bindings, [lastSegment]: pathSegments[0] }
        : { ...bindings };
      const deeper = collectAncestors(child, pathSegments.slice(1), newBindings);
      ancestors.push(...deeper);
      return ancestors;
    }
  }

  return ancestors;
}

export class SimulateHandler {
  execute(ir: RtdbIR | null, rawInput: unknown): SimulateResult {
    if (!ir) {
      return {
        success: false,
        error: {
          code: 'IR_NOT_GENERATED',
          message: 'Call generateIR() before simulate()',
          recoverable: true,
        },
      };
    }

    const parsed = SimulationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: parsed.error.message,
          recoverable: true,
        },
      };
    }

    const { operation, path, auth, mockData, newData } = parsed.data;

    try {
      const pathSegments = path.split('/').filter(Boolean);
      const rootNode = ir.rules as RtdbNode;

      const ancestors = collectAncestors(rootNode, pathSegments, {});

      // Walk from root down. First ancestor whose rule evaluates to true wins.
      const rootData = new DataSnapshot(mockData, '/');
      const dataAtPath = rootData.child(path.slice(1));
      const newDataSnap = new DataSnapshot(newData ?? null, path);

      const buildContext: ContextBuilder = (data, newDataArg, bindings) => {
        const pvBindings: Record<string, string> = {};
        for (const [k, v] of Object.entries(bindings)) {
          pvBindings[k] = v;
          pvBindings[k.slice(1)] = v;
        }
        return {
          auth: auth ? { uid: auth.uid, token: auth.token } : null,
          data,
          newData: newDataArg,
          root: rootData,
          now: Date.now(),
          pathVariableBindings: pvBindings,
        };
      };

      for (const ancestor of ancestors) {
        const ruleExpr: RtdbRuleExpression | undefined = ancestor.node[operation];
        if (!ruleExpr) continue;
        if (!ruleExpr.parsed.valid) continue;

        const match = grammar.match(ruleExpr.raw.trim());
        const result = evaluateExpression(
          match,
          buildContext(dataAtPath, newDataSnap, ancestor.pathVariableBindings),
        );

        if (Boolean(result)) {
          // A granting `.write` is necessary but not sufficient: RTDB also
          // enforces every `.validate` rule at or below the write location.
          // Unlike `.read`/`.write`, `.validate` does NOT cascade — all must
          // pass (a single failure denies the write). Read ops have no
          // validate phase.
          if (operation === 'write') {
            const located = findWriteLocationNode(rootNode, pathSegments, {});
            const failure = located
              ? findFailingValidate(
                  located.node,
                  dataAtPath,
                  newDataSnap,
                  located.bindings,
                  buildContext,
                )
              : null;
            if (failure) {
              return {
                success: true,
                data: {
                  allowed: false,
                  matchedPath: failure.node.path,
                  matchedRule: failure.rule.raw,
                  reason: 'Validation rule evaluated to false',
                  pathVariableBindings: failure.bindings,
                },
              };
            }
          }
          return {
            success: true,
            data: {
              allowed: true,
              matchedPath: ancestor.node.path,
              matchedRule: ruleExpr.raw,
              reason: 'Rule expression evaluated to true',
              pathVariableBindings: ancestor.pathVariableBindings,
            },
          };
        }
      }

      // No ancestor rule evaluated to true. Use the deepest match for the denial.
      const deepest = ancestors[ancestors.length - 1];
      const deepestRule = deepest.node[operation];

      if (!deepestRule) {
        return {
          success: false,
          error: {
            code: 'NO_MATCHING_RULE',
            message: `No '${operation}' rule found for path '${path}'`,
            recoverable: true,
          },
        };
      }

      return {
        success: true,
        data: {
          allowed: false,
          matchedPath: deepest.node.path,
          matchedRule: deepestRule.raw,
          reason: 'Rule expression evaluated to false',
          pathVariableBindings: deepest.pathVariableBindings,
        },
      };
    } catch (e) {
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
