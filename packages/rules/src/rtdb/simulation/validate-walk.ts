import type { DataSnapshot, EvalContext } from '../grammar/simulator.js';
import type { RtdbNode, RtdbRuleExpression } from '../types.js';
import type { RtdbRuleEvaluation, SimulateResult } from './spec.js';

/** Builds the evaluation context for a rule at a given node — supplied by
 *  `execute` so it can close over `auth` / `root` / the requested op. */
export type ContextBuilder = (
  data: DataSnapshot,
  newData: DataSnapshot,
  bindings: Record<string, string>,
) => EvalContext;

/** The outcome of evaluating one rule: whether it holds, and the runtime
 *  error it raised when it failed that way. */
export interface RuleOutcome {
  holds: boolean;
  runtimeError?: string;
}

export type TracedRuleEvaluator = (
  node: RtdbNode,
  kind: RtdbRuleEvaluation['kind'],
  rule: RtdbRuleExpression,
  bindings: Record<string, string>,
  ctx: EvalContext,
) => RuleOutcome;

export interface ValidateFailure {
  node: RtdbNode;
  rule: RtdbRuleExpression;
  bindings: Record<string, string>;
  /** True when this "failure" is a simulator gap (the grammar could not
   *  parse the `.validate` expression) rather than a genuine `false`
   *  evaluation. A real failure found anywhere in the tree always takes
   *  priority over an unsupported one (AND-semantics: a confirmed DENY
   *  is stronger evidence than an abstention). */
  unsupported?: boolean;
  /** The runtime error the rule raised, when it failed by raising one
   *  rather than by evaluating to false. */
  runtimeError?: string;
}

export interface ValidateWalkInput {
  rootNode: RtdbNode;
  rootData: DataSnapshot;
  mergedRootData: DataSnapshot;
  buildContext: ContextBuilder;
  evaluateTracedRule: TracedRuleEvaluator;
  trace: RtdbRuleEvaluation[];
  pathToWrite: string[];
  updates?: readonly { path: string; value?: unknown }[];
}

/**
 * The trace entry for one rule at `node`. `outcome` is absent for a rule the
 * simulator cannot evaluate, which is recorded as `UNSUPPORTED`.
 */
export function traceEntry(
  node: RtdbNode,
  kind: RtdbRuleEvaluation['kind'],
  rule: RtdbRuleExpression,
  bindings: Record<string, string>,
  outcome: RuleOutcome | undefined,
): RtdbRuleEvaluation {
  const entry: RtdbRuleEvaluation = {
    path: node.path,
    kind,
    conditionText: rule.raw,
    verdict: 'UNSUPPORTED',
    pathVariableBindings: { ...bindings },
  };
  if (outcome === undefined) {
    const details = rule.parsed.errors.map((e) => e.message).join('; ');
    entry.message = details === ''
      ? 'The simulator cannot evaluate this expression'
      : `The simulator cannot evaluate this expression: ${details}`;
  } else if (outcome.runtimeError !== undefined) {
    entry.verdict = 'ERROR';
    entry.message = outcome.runtimeError;
  } else {
    entry.verdict = outcome.holds ? 'ALLOW' : 'DENY';
  }
  return entry;
}

/** Own-enumerable keys of a snapshot's object value; empty for non-objects. */
function snapshotChildKeys(snap: DataSnapshot): string[] {
  const value = snap.val();
  if (value === null || typeof value !== 'object') return [];
  return Object.keys(value as object);
}

/** The last segment of a rule node's path: its key, or `$name` for a wildcard. */
function keyOf(node: RtdbNode): string | undefined {
  const segments = node.path.split('/').filter(Boolean);
  return segments[segments.length - 1];
}

/**
 * The child rule node that applies to `key`: the literal child that names it,
 * else the `$wildcard` child, bound to it. Production applies a wildcard only
 * to keys no literal sibling names, whichever is declared first.
 */
export function childFor(node: RtdbNode, key: string): { child: RtdbNode; variable?: string } | undefined {
  let wildcard: { child: RtdbNode; variable: string } | undefined;
  for (const child of node.children) {
    const childKey = keyOf(child);
    if (childKey === undefined) continue;
    if (childKey === key) return { child };
    const isWildcard = childKey.startsWith('$');
    if (isWildcard && wildcard === undefined) wildcard = { child, variable: childKey };
  }
  return wildcard;
}

/** The `$wildcard` child rule node, which applies to a key no literal sibling names (a `push` id), with its variable. */
export function wildcardChildOf(node: RtdbNode): { child: RtdbNode; variable: string } | undefined {
  for (const child of node.children) {
    const childKey = keyOf(child);
    if (childKey !== undefined && childKey.startsWith('$')) return { child, variable: childKey };
  }
  return undefined;
}

/**
 * `.validate` enforcement for a write. RTDB evaluates every rule on the path
 * from the root to each write location (every path of a multi-path update),
 * then every descendant rule present in the written value, whether or not
 * that value differs from the stored one. A sibling node the write does not
 * carry is not validated, even when its stored value fails its rule. Each
 * rule sees the merged post-write snapshot rooted at its own location.
 * Unlike `.read`/`.write`, validation never grants: ALL applicable rules must
 * evaluate true. Null proposed values are skipped.
 *
 * An unparseable `.validate` expression is a simulator gap, not a pass:
 * production would still evaluate it and may reject the write, so treating
 * it as "no rule" would be a fidelity lie. It is reported as `unsupported`
 * (an abstention) rather than fabricated as either ALLOW or DENY — mirrors
 * the Firestore simulator's posture where an `UnsupportedError` never
 * counts as a real evaluation. A genuine `false` found anywhere in the
 * tree still wins over an unsupported node elsewhere (a confirmed DENY is
 * stronger evidence than an abstention). Returns the first real failure, else
 * the first unsupported node, else `null` when every applicable `.validate`
 * passes. Every `.validate` the walk reaches is appended to `trace`.
 */
export function findFailingValidate(input: ValidateWalkInput): ValidateFailure | null {
  const {
    rootNode,
    rootData,
    mergedRootData,
    buildContext,
    evaluateTracedRule,
    trace,
    pathToWrite,
    updates,
  } = input;
  let firstUnsupported: ValidateFailure | null = null;

  const dataWritePathStrings = new Set<string>();
  const allTargetPathStrings = new Set<string>();
  if (updates && updates.length > 0) {
    for (const u of updates) {
      const segs = u.path.split('/').filter(Boolean);
      const isPriorityOnly = segs[segs.length - 1] === '.priority';
      const effective = isPriorityOnly ? segs.slice(0, -1) : segs;
      const joined = effective.join('/');
      allTargetPathStrings.add(joined);
      if (!isPriorityOnly) dataWritePathStrings.add(joined);
    }
  } else {
    const clean = pathToWrite.filter(Boolean);
    const isPriorityOnly = clean[clean.length - 1] === '.priority';
    const effective = isPriorityOnly ? clean.slice(0, -1) : clean;
    const joined = effective.join('/');
    allTargetPathStrings.add(joined);
    if (!isPriorityOnly) dataWritePathStrings.add(joined);
  }
  const dataWritePaths = Array.from(dataWritePathStrings).map((p) => p.split('/').filter(Boolean));
  const allWritePaths = Array.from(allTargetPathStrings).map((p) => p.split('/').filter(Boolean));

  /** The next key of every write path that passes through `currentSegments`. */
  function writeKeysBelow(currentSegments: readonly string[]): Set<string> {
    const keys = new Set<string>();
    for (const wp of allWritePaths) {
      const passesThrough = wp.length > currentSegments.length &&
        currentSegments.every((seg, idx) => seg === wp[idx]);
      if (passesThrough) keys.add(wp[currentSegments.length]!);
    }
    return keys;
  }

  function walk(
    node: RtdbNode,
    data: DataSnapshot,
    newData: DataSnapshot,
    bindings: Record<string, string>,
    currentSegments: string[],
  ): ValidateFailure | null {
    if (newData.exists()) {
      const rule = node.validate;
      if (rule) {
        if (!rule.parsed.valid) {
          trace.push(traceEntry(node, 'validate', rule, bindings, undefined));
          if (!firstUnsupported) {
            firstUnsupported = { node, rule, bindings, unsupported: true };
          }
        } else {
          const outcome = evaluateTracedRule(
            node,
            'validate',
            rule,
            bindings,
            buildContext(data, newData, bindings),
          );
          if (!outcome.holds) {
            return { node, rule, bindings, runtimeError: outcome.runtimeError };
          }
        }
      }
    }

    // At or below a data write location the written value is present in full,
    // so every child it carries is visited. Above one (or at a `.priority`-only
    // target), only the children on a write path are: an untouched child or
    // sibling the write does not carry is never validated.
    const isAtOrBelowWriteTarget = dataWritePaths.some(
      (wp) => wp.length <= currentSegments.length && wp.every((seg, idx) => seg === currentSegments[idx]),
    );
    const childKeys = isAtOrBelowWriteTarget
      ? snapshotChildKeys(newData)
      : writeKeysBelow(currentSegments);

    for (const key of childKeys) {
      const matched = childFor(node, key);
      if (matched === undefined) continue;
      const childBindings = matched.variable === undefined
        ? bindings
        : { ...bindings, [matched.variable]: key };
      const failure = walk(
        matched.child,
        data.child(key),
        newData.child(key),
        childBindings,
        [...currentSegments, key],
      );
      if (failure) return failure;
    }

    return null;
  }

  const realFailure = walk(rootNode, rootData, mergedRootData, {}, []);
  return realFailure ?? firstUnsupported;
}

/** The denial result for a failing `.validate` rule. */
export function toValidateFailureResult(
  failure: ValidateFailure,
  trace: RtdbRuleEvaluation[],
): SimulateResult {
  let reason = 'Validation rule evaluated to false';
  if (failure.unsupported) {
    reason = `Validation rule at '${failure.node.path}' contains an expression the simulator cannot evaluate: ${failure.rule.raw}. It was not evaluated; production may reject this write.`;
  } else if (failure.runtimeError !== undefined) {
    reason = `Validation rule at '${failure.node.path}' failed at evaluation: ${failure.runtimeError}`;
  }
  return {
    success: true,
    data: {
      allowed: false,
      unsupported: failure.unsupported === true,
      matchedPath: failure.node.path,
      matchedRule: failure.rule.raw,
      reason,
      pathVariableBindings: failure.bindings,
      trace,
    },
  };
}
