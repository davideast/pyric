/**
 * Incoming `customMetadata` literal `ValueHint` extraction for Cloud Storage
 * security rules (`request.resource.metadata.<key> == <literal>`).
 */
import type { Expression } from '../../rules/internal/index.js';
import {
  classifyTernaryBranches,
  inlineRuleCall,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';
import { incomingMetadataDirectKey, scalarLiteral } from './storage-constraint-summary.js';
import type { ValueHint } from './value-hints.js';

export function extractStorageAllowValueHints(
  condition: Expression,
  scope: RuleAstScope,
  scopedObjectPath: string,
): ValueHint[] {
  const out: ValueHint[] = [];
  const seen = new Set<string>();
  const addHint = (
    key: string | undefined,
    lit: string | number | boolean | null | undefined,
  ): void => {
    if (key === undefined || lit === undefined || lit === null) return;
    const dedupeKey = `${key}|${typeof lit}:${String(lit)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({ service: 'storage', path: scopedObjectPath, field: key, value: lit });
  };

  const walk = (expr: Expression, s: RuleAstScope, negated: boolean): void => {
    const { expr: e, scope: rs } = resolveRuleExpr(expr, s);
    if (e.type === 'unaryOp') {
      let nextNeg = negated;
      if (e.op === '!') nextNeg = !negated;
      walk(e.operand, rs, nextNeg);
      return;
    }
    if (e.type === 'binaryOp') {
      if (e.op === '==' || e.op === '!=') {
        const leftLit = scalarLiteral(e.left, rs);
        const rightLit = scalarLiteral(e.right, rs);
        if (typeof leftLit === 'boolean' || typeof rightLit === 'boolean') {
          let boolVal = false;
          let target = e.left;
          if (typeof leftLit === 'boolean') {
            boolVal = leftLit;
            target = e.right;
          } else if (typeof rightLit === 'boolean') {
            boolVal = rightLit;
            target = e.left;
          }
          const flips = (e.op === '==' && !boolVal) || (e.op === '!=' && boolVal);
          let nextNeg = negated;
          if (flips) nextNeg = !negated;
          walk(target, rs, nextNeg);
          return;
        }
        if ((e.op === '==' && !negated) || (e.op === '!=' && negated)) {
          addHint(incomingMetadataDirectKey(e.left, rs), rightLit);
          addHint(incomingMetadataDirectKey(e.right, rs), leftLit);
        }
        return;
      }
      walk(e.left, rs, negated);
      walk(e.right, rs, negated);
      return;
    }
    if (e.type === 'ternary') {
      const rawCons = scalarLiteral(e.consequent, rs);
      const rawAlt = scalarLiteral(e.alternate, rs);
      let consBool: boolean | undefined;
      if (typeof rawCons === 'boolean') consBool = rawCons;
      let altBool: boolean | undefined;
      if (typeof rawAlt === 'boolean') altBool = rawAlt;
      const plan = classifyTernaryBranches(consBool, altBool, negated);
      if (plan.conditionNegated === undefined) return;
      walk(e.condition, rs, plan.conditionNegated);
      if (plan.visitConsequent) walk(e.consequent, rs, negated);
      if (plan.visitAlternate) walk(e.alternate, rs, negated);
      return;
    }
    if (e.type === 'functionCall') {
      const inlined = inlineRuleCall(e, rs);
      if (inlined) walk(inlined.expr, inlined.scope, negated);
    }
  };

  walk(condition, scope, false);
  return out;
}
