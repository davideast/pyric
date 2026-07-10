import { grammar } from '../grammar/RtdbExprParser.js';
import { DataSnapshot, evaluateExpression } from '../grammar/simulator.js';
import type { EvalContext } from '../grammar/simulator.js';
import type { RtdbIR, RtdbNode, RtdbRuleExpression } from '../types.js';
import { SimulationInputSchema } from './spec.js';
import type { SimulateResult } from './spec.js';

interface AncestorMatch {
  node: RtdbNode;
  pathVariableBindings: Record<string, string>;
  /** Number of `path` segments consumed to reach this node from the root —
   *  i.e. this ancestor's own location, used to root `data`/`newData` at
   *  the rule's location rather than at the operation's target path. */
  depth: number;
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
  /** True when this "failure" is a simulator gap (the grammar could not
   *  parse the `.validate` expression) rather than a genuine `false`
   *  evaluation. A real failure found anywhere in the tree always takes
   *  priority over an unsupported one (AND-semantics: a confirmed DENY
   *  is stronger evidence than an abstention). */
  unsupported?: boolean;
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
 * whole write. Nodes whose proposed value is null (a delete) are skipped.
 *
 * An unparseable `.validate` expression is a simulator gap, not a pass:
 * production would still evaluate it and may reject the write, so treating
 * it as "no rule" would be a fidelity lie. It is reported as `unsupported`
 * (an abstention) rather than fabricated as either ALLOW or DENY — mirrors
 * the Firestore simulator's posture where an `UnsupportedError` never
 * counts as a real evaluation. A genuine `false` found anywhere in the
 * tree still wins over an unsupported node elsewhere (a confirmed DENY is
 * stronger evidence than an abstention). Ancestor `.validate` rules ABOVE
 * the write location are not evaluated. Returns the first real failure,
 * else the first unsupported node, else `null` when every applicable
 * `.validate` passes.
 */
function findFailingValidate(
  node: RtdbNode,
  data: DataSnapshot,
  newData: DataSnapshot,
  bindings: Record<string, string>,
  buildContext: ContextBuilder,
): ValidateFailure | null {
  let firstUnsupported: ValidateFailure | null = null;

  function walk(
    node: RtdbNode,
    data: DataSnapshot,
    newData: DataSnapshot,
    bindings: Record<string, string>,
  ): ValidateFailure | null {
    // A null proposed value is a delete — RTDB does not validate deletes.
    if (!newData.exists()) return null;

    const rule = node.validate;
    if (rule) {
      if (!rule.parsed.valid) {
        if (!firstUnsupported) {
          firstUnsupported = { node, rule, bindings, unsupported: true };
        }
      } else {
        const match = grammar.match(rule.raw.trim());
        const result = evaluateExpression(match, buildContext(data, newData, bindings));
        if (!result) return { node, rule, bindings };
      }
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
          const failure = walk(
            child,
            data.child(key),
            newData.child(key),
            { ...bindings, [lastSegment]: key },
          );
          if (failure) return failure;
        }
      } else {
        const failure = walk(child, data.child(lastSegment), newData.child(lastSegment), bindings);
        if (failure) return failure;
      }
    }

    return null;
  }

  const realFailure = walk(node, data, newData, bindings);
  return realFailure ?? firstUnsupported;
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
  depth = 0,
): AncestorMatch[] {
  const ancestors: AncestorMatch[] = [{ node, pathVariableBindings: { ...bindings }, depth }];

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
      const deeper = collectAncestors(child, pathSegments.slice(1), newBindings, depth + 1);
      ancestors.push(...deeper);
      return ancestors;
    }
  }

  return ancestors;
}

/**
 * Return a new tree equal to `root` but with the value at `segments`
 * replaced by `value` (a `null`/`undefined` value deletes the node, same
 * as an RTDB write of `null`). Used to build the post-write tree so that
 * `newData` at an ANCESTOR of the write location reflects the merged
 * result at that ancestor's own path, not just the raw payload at the
 * deepest write path.
 */
function withValueAt(root: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value ?? null;

  const [head, ...rest] = segments;
  const currentObj: Record<string, unknown> =
    root !== null && typeof root === 'object' && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {};

  const existingChild = Object.hasOwn(currentObj, head) ? currentObj[head] : null;
  const childValue = withValueAt(existingChild, rest, value);

  if (childValue === null || childValue === undefined) {
    delete currentObj[head];
  } else {
    currentObj[head] = childValue;
  }

  return currentObj;
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
      //
      // `data`/`newData` must be rooted at EACH ancestor's own location —
      // not at the operation's target path — matching live RTDB semantics:
      // a rule declared at `/rooms/$roomId` sees `data`/`newData` as the
      // snapshot AT `/rooms/$roomId`, even when the write is deeper (e.g.
      // `/rooms/$roomId/title`). Rooting everything at the deepest write
      // path instead makes ancestor rules see "no data" (since the
      // deepest path usually doesn't exist yet), which silently satisfies
      // `!data.exists()`-style escape hatches and produces a false ALLOW.
      const rootData = new DataSnapshot(mockData, '/');
      // Post-write tree: mockData with `newData` merged in at the write
      // path. Reads don't have a "post-write" state, so leave it as-is.
      const mergedRoot =
        operation === 'read' ? mockData : withValueAt(mockData, pathSegments, newData ?? null);
      const mergedRootData = new DataSnapshot(mergedRoot, '/');

      const dataAtPath = rootData.child(pathSegments.join('/'));
      const newDataSnap = mergedRootData.child(pathSegments.join('/'));

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

      // Tracks the first ancestor whose `.write`/`.read` rule the grammar
      // couldn't parse. Unlike `.validate`, `.write`/`.read` rules cascade
      // (any ancestor granting `true` wins), so an unparseable rule is not
      // simply "no rule here" — production would still evaluate it and
      // might grant on it. If no ancestor grants and no real deny is
      // found either, this reported as `unsupported` rather than a
      // fabricated deny.
      let firstUnsupportedAncestor: AncestorMatch | undefined;

      for (const ancestor of ancestors) {
        const ruleExpr: RtdbRuleExpression | undefined = ancestor.node[operation];
        if (!ruleExpr) continue;
        if (!ruleExpr.parsed.valid) {
          if (!firstUnsupportedAncestor) firstUnsupportedAncestor = ancestor;
          continue;
        }

        const ancestorSegments = pathSegments.slice(0, ancestor.depth).join('/');
        const dataAtAncestor = rootData.child(ancestorSegments);
        const newDataAtAncestor = mergedRootData.child(ancestorSegments);

        const match = grammar.match(ruleExpr.raw.trim());
        const result = evaluateExpression(
          match,
          buildContext(dataAtAncestor, newDataAtAncestor, ancestor.pathVariableBindings),
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
                  unsupported: failure.unsupported === true,
                  matchedPath: failure.node.path,
                  matchedRule: failure.rule.raw,
                  reason: failure.unsupported
                    ? `Validation rule at '${failure.node.path}' contains an expression the simulator cannot evaluate: ${failure.rule.raw} — not evaluated; production may reject this write.`
                    : 'Validation rule evaluated to false',
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
          },
        };
      }

      // Use the deepest match for the denial.
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
