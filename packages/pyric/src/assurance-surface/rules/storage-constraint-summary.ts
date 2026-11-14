/**
 * Summary lattice and boolean predicate summarization for Cloud Storage upload
 * and stored metadata constraints (`contentType`, `size`, HTTP headers, `customMetadata`).
 */
import type { Expression } from '../../rules/internal/index.js';
import type { StorageHttpHeaderKey } from '../code/types.js';
import {
  inlineRuleCall,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';
import {
  distributeOrConjunctLists,
  escapeRegexLiteral,
  evalNumericExpr,
  formatContentTypePatterns,
  incomingHttpHeaderKey,
  incomingMetadataDirectKey,
  incomingMetadataGetCall,
  isRequestResource,
  isRequestResourceMetadata,
  isRequestResourceMetadataKeys,
  isRequestResourceProp,
  isUnshadowedIdent,
  mergeConjunctLists,
  mergeHttpHeaderMaps,
  propOf,
  recordGetRequiredKey,
  scalarLiteral,
  STORAGE_HTTP_HEADER_KEYS,
  storedHttpHeaderKey,
  stringListElements,
  type HttpHeaderConjunctMap,
} from './storage-constraint-ast.js';

export {
  distributeOrConjunctLists,
  evalNumericExpr,
  formatContentTypePatterns,
  incomingMetadataDirectKey,
  isUnshadowedIdent,
  mergeConjunctLists,
  mergeHttpHeaderMaps,
  propOf,
  scalarLiteral,
  STORAGE_HTTP_HEADER_KEYS,
  type HttpHeaderConjunctMap,
};

export interface ConstraintSummary {
  readonly impossible: boolean;
  readonly contentTypeConjuncts?: readonly (readonly string[])[];
  readonly minSizeBytes?: number;
  readonly maxSizeBytes?: number;
  readonly requiredKeys: Set<string>;
  readonly httpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
  readonly nullHttpHeaders: Set<StorageHttpHeaderKey>;
  readonly storedHttpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
}

function emptySummary(): ConstraintSummary {
  return {
    impossible: false,
    requiredKeys: new Set(),
    httpHeaders: new Map(),
    nullHttpHeaders: new Set(),
    storedHttpHeaders: new Map(),
  };
}

function impossibleSummary(): ConstraintSummary {
  return {
    impossible: true,
    requiredKeys: new Set(),
    httpHeaders: new Map(),
    nullHttpHeaders: new Set(),
    storedHttpHeaders: new Map(),
  };
}

function orHttpHeaderMaps(
  left: HttpHeaderConjunctMap,
  right: HttpHeaderConjunctMap,
): Map<StorageHttpHeaderKey, readonly (readonly string[])[]> {
  const out = new Map<StorageHttpHeaderKey, readonly (readonly string[])[]>();
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const l = left.get(key);
    const r = right.get(key);
    if (l && r) {
      const distributed = distributeOrConjunctLists([l, r]);
      if (distributed.length > 0) out.set(key, distributed);
    }
  }
  return out;
}

function andSummary(left: ConstraintSummary, right: ConstraintSummary): ConstraintSummary {
  if (left.impossible || right.impossible) return impossibleSummary();
  let contentTypeConjuncts: (readonly string[])[] | undefined;
  if (left.contentTypeConjuncts && right.contentTypeConjuncts) {
    contentTypeConjuncts = mergeConjunctLists(left.contentTypeConjuncts, right.contentTypeConjuncts);
  } else if (left.contentTypeConjuncts) {
    contentTypeConjuncts = left.contentTypeConjuncts.map((c) => [...c]);
  } else if (right.contentTypeConjuncts) {
    contentTypeConjuncts = right.contentTypeConjuncts.map((c) => [...c]);
  }

  let minSizeBytes: number | undefined;
  if (left.minSizeBytes !== undefined && right.minSizeBytes !== undefined) {
    minSizeBytes = Math.max(left.minSizeBytes, right.minSizeBytes);
  } else if (left.minSizeBytes !== undefined) {
    minSizeBytes = left.minSizeBytes;
  } else if (right.minSizeBytes !== undefined) {
    minSizeBytes = right.minSizeBytes;
  }

  let maxSizeBytes: number | undefined;
  if (left.maxSizeBytes !== undefined && right.maxSizeBytes !== undefined) {
    maxSizeBytes = Math.min(left.maxSizeBytes, right.maxSizeBytes);
  } else if (left.maxSizeBytes !== undefined) {
    maxSizeBytes = left.maxSizeBytes;
  } else if (right.maxSizeBytes !== undefined) {
    maxSizeBytes = right.maxSizeBytes;
  }

  if (minSizeBytes !== undefined && maxSizeBytes !== undefined && minSizeBytes > maxSizeBytes) {
    return impossibleSummary();
  }

  const httpHeaders = mergeHttpHeaderMaps(left.httpHeaders, right.httpHeaders);
  const nullHttpHeaders = new Set<StorageHttpHeaderKey>([
    ...left.nullHttpHeaders,
    ...right.nullHttpHeaders,
  ]);
  for (const nullKey of nullHttpHeaders) {
    if (httpHeaders.has(nullKey)) return impossibleSummary();
  }
  const storedHttpHeaders = mergeHttpHeaderMaps(left.storedHttpHeaders, right.storedHttpHeaders);

  const requiredKeys = new Set<string>([...left.requiredKeys, ...right.requiredKeys]);
  const out: {
    impossible: boolean;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredKeys: Set<string>;
    httpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
    nullHttpHeaders: Set<StorageHttpHeaderKey>;
    storedHttpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
  } = { impossible: false, requiredKeys, httpHeaders, nullHttpHeaders, storedHttpHeaders };
  if (contentTypeConjuncts !== undefined && contentTypeConjuncts.length > 0) {
    out.contentTypeConjuncts = contentTypeConjuncts;
  }
  if (minSizeBytes !== undefined) out.minSizeBytes = minSizeBytes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  return out;
}

function orSummary(left: ConstraintSummary, right: ConstraintSummary): ConstraintSummary {
  if (left.impossible && right.impossible) return impossibleSummary();
  if (left.impossible) return right;
  if (right.impossible) return left;

  let contentTypeConjuncts: (readonly string[])[] | undefined;
  if (left.contentTypeConjuncts && right.contentTypeConjuncts) {
    const distributed = distributeOrConjunctLists([
      left.contentTypeConjuncts,
      right.contentTypeConjuncts,
    ]);
    if (distributed.length > 0) contentTypeConjuncts = distributed;
  }

  let minSizeBytes: number | undefined;
  if (left.minSizeBytes !== undefined && right.minSizeBytes !== undefined) {
    minSizeBytes = Math.min(left.minSizeBytes, right.minSizeBytes);
  }
  let maxSizeBytes: number | undefined;
  if (left.maxSizeBytes !== undefined && right.maxSizeBytes !== undefined) {
    maxSizeBytes = Math.max(left.maxSizeBytes, right.maxSizeBytes);
  }

  const requiredKeys = new Set<string>();
  for (const key of left.requiredKeys) {
    if (right.requiredKeys.has(key)) requiredKeys.add(key);
  }
  const nullHttpHeaders = new Set<StorageHttpHeaderKey>();
  for (const key of left.nullHttpHeaders) {
    if (right.nullHttpHeaders.has(key)) nullHttpHeaders.add(key);
  }

  const out: {
    impossible: boolean;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredKeys: Set<string>;
    httpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
    nullHttpHeaders: Set<StorageHttpHeaderKey>;
    storedHttpHeaders: Map<StorageHttpHeaderKey, readonly (readonly string[])[]>;
  } = {
    impossible: false,
    requiredKeys,
    httpHeaders: orHttpHeaderMaps(left.httpHeaders, right.httpHeaders),
    nullHttpHeaders,
    storedHttpHeaders: orHttpHeaderMaps(left.storedHttpHeaders, right.storedHttpHeaders),
  };
  if (contentTypeConjuncts !== undefined) out.contentTypeConjuncts = contentTypeConjuncts;
  if (minSizeBytes !== undefined) out.minSizeBytes = minSizeBytes;
  if (maxSizeBytes !== undefined) out.maxSizeBytes = maxSizeBytes;
  return out;
}

function negateComparisonOp(op: string): string {
  switch (op) {
    case '<':
      return '>=';
    case '<=':
      return '>';
    case '>':
      return '<=';
    case '>=':
      return '<';
    default:
      return op;
  }
}

export function summarizeBinaryComparison(
  e: Extract<Expression, { type: 'binaryOp' }>,
  s: RuleAstScope,
  negated: boolean,
): ConstraintSummary {
  const out = emptySummary();
  if (e.op === '==' || e.op === '!=') {
    const leftLit = scalarLiteral(e.left, s);
    const rightLit = scalarLiteral(e.right, s);
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
      return summarizeConstraints(target, s, nextNeg);
    }

    const isPosEq = (e.op === '==' && !negated) || (e.op === '!=' && negated);
    const isPosNeq = (e.op === '!=' && !negated) || (e.op === '==' && negated);
    if (isPosEq) {
      if (
        (isRequestResource(e.left, s) && rightLit === null)
        || (isRequestResource(e.right, s) && leftLit === null)
      ) {
        return impossibleSummary();
      }
      if (isRequestResourceProp(e.left, s, 'contentType') && typeof rightLit === 'string') {
        return { ...emptySummary(), contentTypeConjuncts: [[`^${escapeRegexLiteral(rightLit)}$`]] };
      }
      if (isRequestResourceProp(e.right, s, 'contentType') && typeof leftLit === 'string') {
        return { ...emptySummary(), contentTypeConjuncts: [[`^${escapeRegexLiteral(leftLit)}$`]] };
      }
      const leftInHeader = incomingHttpHeaderKey(e.left, s);
      if (leftInHeader !== undefined) {
        if (typeof rightLit === 'string') {
          out.httpHeaders.set(leftInHeader, [[`^${escapeRegexLiteral(rightLit)}$`]]);
          return out;
        }
        if (rightLit === null) {
          out.nullHttpHeaders.add(leftInHeader);
          return out;
        }
      }
      const rightInHeader = incomingHttpHeaderKey(e.right, s);
      if (rightInHeader !== undefined) {
        if (typeof leftLit === 'string') {
          out.httpHeaders.set(rightInHeader, [[`^${escapeRegexLiteral(leftLit)}$`]]);
          return out;
        }
        if (leftLit === null) {
          out.nullHttpHeaders.add(rightInHeader);
          return out;
        }
      }
      const leftStoredHeader = storedHttpHeaderKey(e.left, s);
      if (leftStoredHeader !== undefined && typeof rightLit === 'string') {
        out.storedHttpHeaders.set(leftStoredHeader, [[`^${escapeRegexLiteral(rightLit)}$`]]);
        return out;
      }
      const rightStoredHeader = storedHttpHeaderKey(e.right, s);
      if (rightStoredHeader !== undefined && typeof leftLit === 'string') {
        out.storedHttpHeaders.set(rightStoredHeader, [[`^${escapeRegexLiteral(leftLit)}$`]]);
        return out;
      }

      let exactSize: number | undefined;
      if (isRequestResourceProp(e.left, s, 'size')) exactSize = evalNumericExpr(e.right, s);
      else if (isRequestResourceProp(e.right, s, 'size')) exactSize = evalNumericExpr(e.left, s);
      if (exactSize !== undefined && Number.isFinite(exactSize)) {
        if (!Number.isInteger(exactSize) || exactSize < 0) return impossibleSummary();
        if (exactSize > 0) {
          return { ...emptySummary(), minSizeBytes: exactSize, maxSizeBytes: exactSize };
        }
        return { ...emptySummary(), maxSizeBytes: exactSize };
      }

      const leftKey = incomingMetadataDirectKey(e.left, s);
      if (leftKey !== undefined && rightLit !== null) out.requiredKeys.add(leftKey);
      const rightKey = incomingMetadataDirectKey(e.right, s);
      if (rightKey !== undefined && leftLit !== null) out.requiredKeys.add(rightKey);

      recordGetRequiredKey(incomingMetadataGetCall(e.left, s), e.right, rightLit, s, out.requiredKeys);
      recordGetRequiredKey(incomingMetadataGetCall(e.right, s), e.left, leftLit, s, out.requiredKeys);
      return out;
    }

    if (isPosNeq) {
      const leftKey = incomingMetadataDirectKey(e.left, s);
      if (leftKey !== undefined && rightLit === null) out.requiredKeys.add(leftKey);
      const rightKey = incomingMetadataDirectKey(e.right, s);
      if (rightKey !== undefined && leftLit === null) out.requiredKeys.add(rightKey);
      const leftInHeader = incomingHttpHeaderKey(e.left, s);
      if (leftInHeader !== undefined && rightLit === null) out.httpHeaders.set(leftInHeader, [['.*']]);
      const rightInHeader = incomingHttpHeaderKey(e.right, s);
      if (rightInHeader !== undefined && leftLit === null) out.httpHeaders.set(rightInHeader, [['.*']]);
      const leftStoredHeader = storedHttpHeaderKey(e.left, s);
      if (leftStoredHeader !== undefined && rightLit === null) {
        out.storedHttpHeaders.set(leftStoredHeader, [['.*']]);
      }
      const rightStoredHeader = storedHttpHeaderKey(e.right, s);
      if (rightStoredHeader !== undefined && leftLit === null) {
        out.storedHttpHeaders.set(rightStoredHeader, [['.*']]);
      }
    }
    return out;
  }

  let op = e.op;
  if (negated) op = negateComparisonOp(e.op);
  let sizeBound: number | undefined;
  let sizeOp = op;
  if (isRequestResourceProp(e.left, s, 'size')) {
    sizeBound = evalNumericExpr(e.right, s);
  } else if (isRequestResourceProp(e.right, s, 'size')) {
    sizeBound = evalNumericExpr(e.left, s);
    if (op === '<') sizeOp = '>';
    else if (op === '<=') sizeOp = '>=';
    else if (op === '>') sizeOp = '<';
    else if (op === '>=') sizeOp = '<=';
  }
  if (sizeBound !== undefined && Number.isFinite(sizeBound)) {
    if (sizeOp === '<') {
      const max = Math.ceil(sizeBound) - 1;
      if (max < 0) return impossibleSummary();
      return { ...emptySummary(), maxSizeBytes: max };
    }
    if (sizeOp === '<=') {
      const max = Math.floor(sizeBound);
      if (max < 0) return impossibleSummary();
      return { ...emptySummary(), maxSizeBytes: max };
    }
    if (sizeOp === '>') {
      const min = Math.floor(sizeBound) + 1;
      if (min > 0) return { ...emptySummary(), minSizeBytes: min };
      return out;
    }
    if (sizeOp === '>=') {
      const min = Math.ceil(sizeBound);
      if (min > 0) return { ...emptySummary(), minSizeBytes: min };
      return out;
    }
  }
  const leftResolved = resolveRuleExpr(e.left, s);
  if (
    leftResolved.expr.type === 'methodCall'
    && leftResolved.expr.method === 'size'
    && (op === '>' || op === '>=')
  ) {
    const key = incomingMetadataDirectKey(leftResolved.expr.object, leftResolved.scope);
    if (key !== undefined) out.requiredKeys.add(key);
    const inHeader = incomingHttpHeaderKey(leftResolved.expr.object, leftResolved.scope);
    if (inHeader !== undefined) out.httpHeaders.set(inHeader, [['.+']]);
    const storedHeader = storedHttpHeaderKey(leftResolved.expr.object, leftResolved.scope);
    if (storedHeader !== undefined) out.storedHttpHeaders.set(storedHeader, [['.+']]);
  }
  return out;
}

export function summarizeConstraints(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): ConstraintSummary {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    let val = e.value;
    if (negated) val = !val;
    if (val) return emptySummary();
    return impossibleSummary();
  }
  if (e.type === 'unaryOp') {
    if (e.op === '!') return summarizeConstraints(e.operand, s, !negated);
    return emptySummary();
  }
  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return andSummary(
        summarizeConstraints(e.left, s, negated),
        summarizeConstraints(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      return orSummary(
        summarizeConstraints(e.left, s, negated),
        summarizeConstraints(e.right, s, negated),
      );
    }
    return summarizeBinaryComparison(e, s, negated);
  }
  if (e.type === 'ternary') {
    const posBranch = andSummary(
      summarizeConstraints(e.condition, s, false),
      summarizeConstraints(e.consequent, s, negated),
    );
    const negBranch = andSummary(
      summarizeConstraints(e.condition, s, true),
      summarizeConstraints(e.alternate, s, negated),
    );
    return orSummary(posBranch, negBranch);
  }
  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return emptySummary();
    return summarizeConstraints(inlined.expr, inlined.scope, negated);
  }
  if (negated) return emptySummary();

  if (e.type === 'methodCall') {
    if (e.method === 'matches' && e.args[0]) {
      const pattern = scalarLiteral(e.args[0], s);
      if (typeof pattern === 'string') {
        if (isRequestResourceProp(e.object, s, 'contentType')) {
          return { ...emptySummary(), contentTypeConjuncts: [[pattern]] };
        }
        const inHeader = incomingHttpHeaderKey(e.object, s);
        if (inHeader !== undefined) {
          const out = emptySummary();
          out.httpHeaders.set(inHeader, [[pattern]]);
          return out;
        }
        const storedHeader = storedHttpHeaderKey(e.object, s);
        if (storedHeader !== undefined) {
          const out = emptySummary();
          out.storedHttpHeaders.set(storedHeader, [[pattern]]);
          return out;
        }
      }
    }
    if (
      (e.method === 'hasAll' || e.method === 'hasAny')
      && isRequestResourceMetadataKeys(e.object, s)
      && e.args[0]
    ) {
      const elems = stringListElements(e.args[0], s);
      if (elems && (e.method === 'hasAll' || elems.length === 1)) {
        return { ...emptySummary(), requiredKeys: new Set(elems) };
      }
    }
    const metaKey = incomingMetadataDirectKey(e.object, s);
    if (metaKey !== undefined) return { ...emptySummary(), requiredKeys: new Set([metaKey]) };
    return emptySummary();
  }

  if (e.type === 'inExpr') {
    const elemStr = scalarLiteral(e.element, s);
    if (
      typeof elemStr === 'string'
      && (isRequestResourceMetadata(e.collection, s) || isRequestResourceMetadataKeys(e.collection, s))
    ) {
      return { ...emptySummary(), requiredKeys: new Set([elemStr]) };
    }
    if (isRequestResourceProp(e.element, s, 'contentType')) {
      const mimes = stringListElements(e.collection, s);
      if (mimes && mimes.length > 0) {
        return {
          ...emptySummary(),
          contentTypeConjuncts: [mimes.map((m) => `^${escapeRegexLiteral(m)}$`)],
        };
      }
    }
    const inHeader = incomingHttpHeaderKey(e.element, s);
    if (inHeader !== undefined) {
      const vals = stringListElements(e.collection, s);
      if (vals && vals.length > 0) {
        const out = emptySummary();
        out.httpHeaders.set(inHeader, [vals.map((v) => `^${escapeRegexLiteral(v)}$`)]);
        return out;
      }
    }
    const storedHeader = storedHttpHeaderKey(e.element, s);
    if (storedHeader !== undefined) {
      const vals = stringListElements(e.collection, s);
      if (vals && vals.length > 0) {
        const out = emptySummary();
        out.storedHttpHeaders.set(storedHeader, [vals.map((v) => `^${escapeRegexLiteral(v)}$`)]);
        return out;
      }
    }
    const directKey = incomingMetadataDirectKey(e.element, s);
    if (directKey !== undefined) return { ...emptySummary(), requiredKeys: new Set([directKey]) };
    return emptySummary();
  }

  if (e.type === 'isExpr') {
    const inHeader = incomingHttpHeaderKey(e.value, s);
    if (inHeader !== undefined) {
      const out = emptySummary();
      if (e.typeName === 'null') out.nullHttpHeaders.add(inHeader);
      else out.httpHeaders.set(inHeader, [['.*']]);
      return out;
    }
    const storedHeader = storedHttpHeaderKey(e.value, s);
    if (storedHeader !== undefined && e.typeName !== 'null') {
      const out = emptySummary();
      out.storedHttpHeaders.set(storedHeader, [['.*']]);
      return out;
    }
    if (e.typeName !== 'null') {
      const directKey = incomingMetadataDirectKey(e.value, s);
      if (directKey !== undefined) return { ...emptySummary(), requiredKeys: new Set([directKey]) };
    }
  }
  return emptySummary();
}
