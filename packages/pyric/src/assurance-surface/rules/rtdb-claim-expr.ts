/**
 * Realtime Database expression-tree visitor for required `auth.token` claims.
 */
import type { RtdbExpressionTree } from '../../rules/internal/rtdb.js';
import {
  intersectClaimList,
  singleClaim,
  STANDARD_CLAIMS,
  unionClaims,
  type Claims,
} from './claim-algebra.js';

function rtdbStaticBool(tree: RtdbExpressionTree): boolean | undefined {
  if (tree.type === 'boolean') return tree.value;
  if (tree.type === 'unary' && tree.operator === '!') {
    const inner = rtdbStaticBool(tree.argument);
    if (inner === undefined) return undefined;
    return !inner;
  }
  return undefined;
}

export function rtdbEffectiveBool(tree: RtdbExpressionTree, negated: boolean): boolean | undefined {
  const raw = rtdbStaticBool(tree);
  if (raw === undefined) return undefined;
  if (negated) return !raw;
  return raw;
}

function isRtdbAuthToken(tree: RtdbExpressionTree): boolean {
  if (tree.type === 'member' && tree.property === 'token') {
    return tree.object.type === 'identifier' && tree.object.name === 'auth';
  }
  if (tree.type === 'index' && tree.index.type === 'string' && tree.index.value === 'token') {
    return tree.object.type === 'identifier' && tree.object.name === 'auth';
  }
  return false;
}

function rtdbTokenClaim(tree: RtdbExpressionTree): string | undefined {
  if (tree.type === 'member' && isRtdbAuthToken(tree.object)) {
    return tree.property;
  }
  if (tree.type === 'index' && tree.index.type === 'string' && isRtdbAuthToken(tree.object)) {
    return tree.index.value;
  }
  return undefined;
}

function rtdbLiteral(tree: RtdbExpressionTree): { value: unknown } | undefined {
  if (tree.type === 'string') return { value: tree.value };
  if (tree.type === 'boolean') return { value: tree.value };
  if (tree.type === 'number') return { value: Number(tree.raw) };
  return undefined;
}

export function rtdbExprClaims(tree: RtdbExpressionTree, negated: boolean): Claims {
  if (tree.type === 'unary') {
    if (tree.operator === '!') return rtdbExprClaims(tree.argument, !negated);
    return {};
  }
  if (tree.type === 'binary' && ((tree.operator === '&&' && !negated) || (tree.operator === '||' && negated))) {
    return unionClaims(rtdbExprClaims(tree.left, negated), rtdbExprClaims(tree.right, negated));
  }
  if (tree.type === 'binary' && ((tree.operator === '||' && !negated) || (tree.operator === '&&' && negated))) {
    const branches: Claims[] = [];
    if (rtdbEffectiveBool(tree.left, negated) !== false) branches.push(rtdbExprClaims(tree.left, negated));
    if (rtdbEffectiveBool(tree.right, negated) !== false) branches.push(rtdbExprClaims(tree.right, negated));
    return intersectClaimList(branches);
  }
  if (tree.type === 'ternary') {
    const effCons = rtdbEffectiveBool(tree.consequent, negated);
    const effAlt = rtdbEffectiveBool(tree.alternate, negated);
    if (effCons === false && effAlt === false) return {};
    if (effAlt === false) {
      return unionClaims(rtdbExprClaims(tree.test, false), rtdbExprClaims(tree.consequent, negated));
    }
    if (effCons === false) {
      return unionClaims(rtdbExprClaims(tree.test, true), rtdbExprClaims(tree.alternate, negated));
    }
    const thenBranch = unionClaims(rtdbExprClaims(tree.test, false), rtdbExprClaims(tree.consequent, negated));
    const elseBranch = unionClaims(rtdbExprClaims(tree.test, true), rtdbExprClaims(tree.alternate, negated));
    return intersectClaimList([thenBranch, elseBranch]);
  }
  if (tree.type === 'binary') {
    const isEq = tree.operator === '==' || tree.operator === '===';
    const isNeq = tree.operator === '!=' || tree.operator === '!==';
    if (isEq || isNeq) {
      const leftClaim = rtdbTokenClaim(tree.left);
      const claim = leftClaim ?? rtdbTokenClaim(tree.right);
      if (claim) {
        if (STANDARD_CLAIMS.has(claim)) return {};
        let other = tree.left;
        if (leftClaim) other = tree.right;
        const isPosEq = (isEq && !negated) || (isNeq && negated);
        const isPosNeq = (isNeq && !negated) || (isEq && negated);
        if (isPosNeq && other.type === 'null') return singleClaim(claim, true);
        const lit = rtdbLiteral(other);
        if (isPosNeq && lit && typeof lit.value === 'boolean' && claim === 'email_verified') {
          return singleClaim(claim, !lit.value);
        }
        if (isPosEq && lit) return singleClaim(claim, lit.value);
        return {};
      }
      const leftBool = rtdbStaticBool(tree.left);
      const rightBool = rtdbStaticBool(tree.right);
      if (leftBool !== undefined || rightBool !== undefined) {
        const boolVal = leftBool ?? rightBool ?? false;
        let target = tree.left;
        if (leftBool !== undefined) target = tree.right;
        const flips = (isEq && !boolVal) || (isNeq && boolVal);
        let nextNegated = negated;
        if (flips) nextNegated = !negated;
        return rtdbExprClaims(target, nextNegated);
      }
    }
    return {};
  }
  const bare = rtdbTokenClaim(tree);
  if (bare && !STANDARD_CLAIMS.has(bare)) {
    if (negated) {
      if (bare === 'email_verified') return singleClaim(bare, false);
      return {};
    }
    return singleClaim(bare, true);
  }
  return {};
}
