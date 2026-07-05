import { grammar } from '../grammar/RtdbExprParser.js';
import { DataSnapshot, evaluateExpression } from '../grammar/simulator.js';
import type { RtdbIR, RtdbNode, RtdbRuleExpression } from '../types.js';
import { SimulationInputSchema } from './spec.js';
import type { SimulateResult } from './spec.js';

interface AncestorMatch {
  node: RtdbNode;
  pathVariableBindings: Record<string, string>;
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

      for (const ancestor of ancestors) {
        const ruleExpr: RtdbRuleExpression | undefined = ancestor.node[operation];
        if (!ruleExpr) continue;
        if (!ruleExpr.parsed.valid) continue;

        const pvBindings: Record<string, string> = {};
        for (const [k, v] of Object.entries(ancestor.pathVariableBindings)) {
          pvBindings[k] = v;
          pvBindings[k.slice(1)] = v;
        }

        const ctx = {
          auth: auth ? { uid: auth.uid, token: auth.token } : null,
          data: dataAtPath,
          newData: newDataSnap,
          root: rootData,
          now: Date.now(),
          pathVariableBindings: pvBindings,
        };

        const match = grammar.match(ruleExpr.raw.trim());
        const result = evaluateExpression(match, ctx);

        if (Boolean(result)) {
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
