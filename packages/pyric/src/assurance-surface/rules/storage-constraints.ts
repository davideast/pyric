/**
 * Cloud Storage security-rule DNF arm extraction and `StorageMetadataConstraint`
 * projection for `RuleSurface`.
 */
import type { Expression } from '../../rules/internal/index.js';
import type { StorageHttpHeaderKey } from '../code/types.js';
import type {
  StorageMetadataConstraint,
  StorageMetadataConstraintArm,
} from './rule-surface.js';
import {
  inlineRuleCall,
  resolveRuleExpr,
  type RuleAstScope,
} from './rules-ast-utils.js';
import {
  distributeOrConjunctLists,
  evalNumericExpr,
  formatContentTypePatterns,
  isUnshadowedIdent,
  mergeConjunctLists,
  mergeHttpHeaderMaps,
  propOf,
  scalarLiteral,
  STORAGE_HTTP_HEADER_KEYS,
  summarizeBinaryComparison,
  summarizeConstraints,
  type ConstraintSummary,
  type HttpHeaderConjunctMap,
} from './storage-constraint-summary.js';
import { extractStorageAllowValueHints } from './storage-value-hints.js';
import type { OwnerCondition } from './types.js';

export {
  evalNumericExpr,
  extractStorageAllowValueHints,
  isUnshadowedIdent,
  propOf,
  scalarLiteral,
};

const MAX_STORAGE_DNF_ARMS = 16;

interface ConstraintArm {
  readonly contentTypeConjuncts: readonly (readonly string[])[];
  readonly minSizeBytes?: number;
  readonly maxSizeBytes?: number;
  readonly requiredKeys: ReadonlySet<string>;
  readonly httpHeaders: HttpHeaderConjunctMap;
  readonly nullHttpHeaders: ReadonlySet<StorageHttpHeaderKey>;
  readonly storedHttpHeaders: HttpHeaderConjunctMap;
}

function emptyArm(): ConstraintArm {
  return {
    contentTypeConjuncts: [],
    requiredKeys: new Set(),
    httpHeaders: new Map(),
    nullHttpHeaders: new Set(),
    storedHttpHeaders: new Map(),
  };
}

function cloneHeaderMap(
  map: HttpHeaderConjunctMap,
): Map<StorageHttpHeaderKey, readonly (readonly string[])[]> {
  const out = new Map<StorageHttpHeaderKey, readonly (readonly string[])[]>();
  for (const [k, v] of map) {
    out.set(k, v.map((c) => [...c]));
  }
  return out;
}

function armFromSummary(summary: ConstraintSummary): ConstraintArm[] {
  if (summary.impossible) return [];
  let conjuncts: (readonly string[])[] = [];
  if (summary.contentTypeConjuncts) {
    conjuncts = summary.contentTypeConjuncts.map((c) => [...c]);
  }
  const arm: {
    contentTypeConjuncts: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredKeys: ReadonlySet<string>;
    httpHeaders: HttpHeaderConjunctMap;
    nullHttpHeaders: ReadonlySet<StorageHttpHeaderKey>;
    storedHttpHeaders: HttpHeaderConjunctMap;
  } = {
    contentTypeConjuncts: conjuncts,
    requiredKeys: new Set(summary.requiredKeys),
    httpHeaders: cloneHeaderMap(summary.httpHeaders),
    nullHttpHeaders: new Set(summary.nullHttpHeaders),
    storedHttpHeaders: cloneHeaderMap(summary.storedHttpHeaders),
  };
  if (summary.minSizeBytes !== undefined) arm.minSizeBytes = summary.minSizeBytes;
  if (summary.maxSizeBytes !== undefined) arm.maxSizeBytes = summary.maxSizeBytes;
  return [arm];
}

function serializeHeaderMap(map: HttpHeaderConjunctMap): string {
  const parts: string[] = [];
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const conjuncts = map.get(key);
    if (conjuncts && conjuncts.length > 0) {
      parts.push(`${key}=${conjuncts.map((c) => c.join('||')).join('&&')}`);
    }
  }
  return parts.join(';');
}

function armSignature(arm: ConstraintArm): string {
  const ct = arm.contentTypeConjuncts.map((c) => c.join('||')).join('&&');
  let minSz = '';
  if (arm.minSizeBytes !== undefined) minSz = String(arm.minSizeBytes);
  let maxSz = '';
  if (arm.maxSizeBytes !== undefined) maxSz = String(arm.maxSizeBytes);
  const keys = [...arm.requiredKeys].sort().join(',');
  const http = serializeHeaderMap(arm.httpHeaders);
  const nullHttp = [...arm.nullHttpHeaders].sort().join(',');
  const storedHttp = serializeHeaderMap(arm.storedHttpHeaders);
  return `${ct}#${minSz}:${maxSz}#${keys}#${http}#${nullHttp}#${storedHttp}`;
}

function dedupeArms(arms: readonly ConstraintArm[]): ConstraintArm[] {
  const seen = new Set<string>();
  const out: ConstraintArm[] = [];
  for (const arm of arms) {
    const sig = armSignature(arm);
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(arm);
    }
  }
  return out;
}

function intersectHeaderMapsAcrossArms(
  arms: readonly ConstraintArm[],
  pick: (arm: ConstraintArm) => HttpHeaderConjunctMap,
): Map<StorageHttpHeaderKey, readonly (readonly string[])[]> {
  const out = new Map<StorageHttpHeaderKey, readonly (readonly string[])[]>();
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const perArm: (readonly (readonly string[])[])[] = [];
    let allHave = true;
    for (const arm of arms) {
      const conjuncts = pick(arm).get(key);
      if (!conjuncts || conjuncts.length === 0) {
        allHave = false;
        break;
      }
      perArm.push(conjuncts);
    }
    if (allHave && perArm.length > 0) {
      const distributed = distributeOrConjunctLists(perArm);
      if (distributed.length > 0) out.set(key, distributed);
    }
  }
  return out;
}

function collapseArms(arms: readonly ConstraintArm[]): ConstraintArm {
  const first = arms[0]!;
  let allHaveCt = first.contentTypeConjuncts.length > 0;
  let allHaveMinSize = first.minSizeBytes !== undefined;
  let minSize = first.minSizeBytes ?? Number.POSITIVE_INFINITY;
  let allHaveMaxSize = first.maxSizeBytes !== undefined;
  let maxSize = first.maxSizeBytes ?? 0;
  const sharedKeys = new Set<string>(first.requiredKeys);
  const sharedNullHttp = new Set<StorageHttpHeaderKey>(first.nullHttpHeaders);
  const armConjunctLists: (readonly (readonly string[])[])[] = [];

  for (const arm of arms) {
    if (arm.contentTypeConjuncts.length === 0) {
      allHaveCt = false;
    } else if (allHaveCt) {
      armConjunctLists.push(arm.contentTypeConjuncts);
    }
    if (arm.minSizeBytes === undefined) {
      allHaveMinSize = false;
    } else if (arm.minSizeBytes < minSize) {
      minSize = arm.minSizeBytes;
    }
    if (arm.maxSizeBytes === undefined) {
      allHaveMaxSize = false;
    } else if (arm.maxSizeBytes > maxSize) {
      maxSize = arm.maxSizeBytes;
    }
    for (const k of [...sharedKeys]) {
      if (!arm.requiredKeys.has(k)) sharedKeys.delete(k);
    }
    for (const k of [...sharedNullHttp]) {
      if (!arm.nullHttpHeaders.has(k)) sharedNullHttp.delete(k);
    }
  }

  let collapsedCt: readonly (readonly string[])[] = [];
  if (allHaveCt && armConjunctLists.length > 0) {
    collapsedCt = distributeOrConjunctLists(armConjunctLists);
  }
  const out: {
    contentTypeConjuncts: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredKeys: ReadonlySet<string>;
    httpHeaders: HttpHeaderConjunctMap;
    nullHttpHeaders: ReadonlySet<StorageHttpHeaderKey>;
    storedHttpHeaders: HttpHeaderConjunctMap;
  } = {
    contentTypeConjuncts: collapsedCt,
    requiredKeys: sharedKeys,
    httpHeaders: intersectHeaderMapsAcrossArms(arms, (a) => a.httpHeaders),
    nullHttpHeaders: sharedNullHttp,
    storedHttpHeaders: intersectHeaderMapsAcrossArms(arms, (a) => a.storedHttpHeaders),
  };
  if (allHaveMinSize && Number.isFinite(minSize)) out.minSizeBytes = minSize;
  if (allHaveMaxSize) out.maxSizeBytes = maxSize;
  return out;
}

function andConstraintArms(
  left: readonly ConstraintArm[],
  right: readonly ConstraintArm[],
): ConstraintArm[] {
  if (left.length === 0 || right.length === 0) return [];
  let lhs = left;
  if (left.length * right.length > MAX_STORAGE_DNF_ARMS) lhs = [collapseArms(left)];
  let rhs = right;
  if (lhs.length * right.length > MAX_STORAGE_DNF_ARMS) rhs = [collapseArms(right)];

  const combined: ConstraintArm[] = [];
  for (const a of lhs) {
    for (const b of rhs) {
      const conjuncts = mergeConjunctLists(a.contentTypeConjuncts, b.contentTypeConjuncts);
      let minSizeBytes: number | undefined;
      if (a.minSizeBytes !== undefined && b.minSizeBytes !== undefined) {
        minSizeBytes = Math.max(a.minSizeBytes, b.minSizeBytes);
      } else if (a.minSizeBytes !== undefined) {
        minSizeBytes = a.minSizeBytes;
      } else if (b.minSizeBytes !== undefined) {
        minSizeBytes = b.minSizeBytes;
      }
      let maxSizeBytes: number | undefined;
      if (a.maxSizeBytes !== undefined && b.maxSizeBytes !== undefined) {
        maxSizeBytes = Math.min(a.maxSizeBytes, b.maxSizeBytes);
      } else if (a.maxSizeBytes !== undefined) {
        maxSizeBytes = a.maxSizeBytes;
      } else if (b.maxSizeBytes !== undefined) {
        maxSizeBytes = b.maxSizeBytes;
      }
      if (minSizeBytes !== undefined && maxSizeBytes !== undefined && minSizeBytes > maxSizeBytes) {
        continue;
      }
      const httpHeaders = mergeHttpHeaderMaps(a.httpHeaders, b.httpHeaders);
      const nullHttpHeaders = new Set<StorageHttpHeaderKey>([
        ...a.nullHttpHeaders,
        ...b.nullHttpHeaders,
      ]);
      let contradictedHttp = false;
      for (const nullKey of nullHttpHeaders) {
        if (httpHeaders.has(nullKey)) {
          contradictedHttp = true;
          break;
        }
      }
      if (contradictedHttp) continue;
      const storedHttpHeaders = mergeHttpHeaderMaps(a.storedHttpHeaders, b.storedHttpHeaders);
      const requiredKeys = new Set<string>([...a.requiredKeys, ...b.requiredKeys]);
      const arm: {
        contentTypeConjuncts: readonly (readonly string[])[];
        minSizeBytes?: number;
        maxSizeBytes?: number;
        requiredKeys: ReadonlySet<string>;
        httpHeaders: HttpHeaderConjunctMap;
        nullHttpHeaders: ReadonlySet<StorageHttpHeaderKey>;
        storedHttpHeaders: HttpHeaderConjunctMap;
      } = {
        contentTypeConjuncts: conjuncts,
        requiredKeys,
        httpHeaders,
        nullHttpHeaders,
        storedHttpHeaders,
      };
      if (minSizeBytes !== undefined) arm.minSizeBytes = minSizeBytes;
      if (maxSizeBytes !== undefined) arm.maxSizeBytes = maxSizeBytes;
      combined.push(arm);
    }
  }
  return dedupeArms(combined);
}

function orConstraintArms(
  left: readonly ConstraintArm[],
  right: readonly ConstraintArm[],
): ConstraintArm[] {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const merged = dedupeArms([...left, ...right]);
  if (merged.length > MAX_STORAGE_DNF_ARMS) return [collapseArms(merged)];
  return merged;
}

function summarizeConstraintArms(
  expr: Expression,
  scope: RuleAstScope,
  negated: boolean,
): ConstraintArm[] {
  const r = resolveRuleExpr(expr, scope);
  const e = r.expr;
  const s = r.scope;

  if (e.type === 'literal' && typeof e.value === 'boolean') {
    let val = e.value;
    if (negated) val = !val;
    if (val) return [emptyArm()];
    return [];
  }
  if (e.type === 'unaryOp') {
    if (e.op === '!') return summarizeConstraintArms(e.operand, s, !negated);
    return [emptyArm()];
  }
  if (e.type === 'binaryOp') {
    if ((e.op === '&&' && !negated) || (e.op === '||' && negated)) {
      return andConstraintArms(
        summarizeConstraintArms(e.left, s, negated),
        summarizeConstraintArms(e.right, s, negated),
      );
    }
    if ((e.op === '||' && !negated) || (e.op === '&&' && negated)) {
      return orConstraintArms(
        summarizeConstraintArms(e.left, s, negated),
        summarizeConstraintArms(e.right, s, negated),
      );
    }
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
        return summarizeConstraintArms(target, s, nextNeg);
      }
    }
    return armFromSummary(summarizeBinaryComparison(e, s, negated));
  }
  if (e.type === 'ternary') {
    const posBranch = andConstraintArms(
      summarizeConstraintArms(e.condition, s, false),
      summarizeConstraintArms(e.consequent, s, negated),
    );
    const negBranch = andConstraintArms(
      summarizeConstraintArms(e.condition, s, true),
      summarizeConstraintArms(e.alternate, s, negated),
    );
    return orConstraintArms(posBranch, negBranch);
  }
  if (e.type === 'functionCall') {
    const inlined = inlineRuleCall(e, s);
    if (!inlined) return [emptyArm()];
    return summarizeConstraintArms(inlined.expr, inlined.scope, negated);
  }
  return armFromSummary(summarizeConstraints(expr, scope, negated));
}

function formatConjunctsPattern(conjuncts: readonly (readonly string[])[]): string | undefined {
  if (conjuncts.length === 0) return undefined;
  if (conjuncts.length === 1) return formatContentTypePatterns(conjuncts[0]!);
  return conjuncts.map((c) => formatContentTypePatterns(c)).join(' && ');
}

function headerMapToRecord(
  map: HttpHeaderConjunctMap,
): Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>> | undefined {
  const out: Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>> = {};
  let hasAny = false;
  for (const key of STORAGE_HTTP_HEADER_KEYS) {
    const conjuncts = map.get(key);
    if (conjuncts && conjuncts.length > 0) {
      out[key] = conjuncts.map((c) => [...c]);
      hasAny = true;
    }
  }
  if (!hasAny) return undefined;
  return out;
}

export function extractStorageMetadataConstraintArms(
  condition: Expression,
  scope: RuleAstScope,
  ownerConditions: readonly OwnerCondition[],
): readonly StorageMetadataConstraintArm[] | undefined {
  const arms = summarizeConstraintArms(condition, scope, false);
  if (arms.length === 0) return undefined;
  const incomingOwner = ownerConditions.find((c) => c.kind === 'incomingField');
  const storedOwner = ownerConditions.find((c) => c.kind === 'storedField');
  const ownerMetadataKey = incomingOwner?.field ?? storedOwner?.field;

  const formattedArms: StorageMetadataConstraintArm[] = arms.map((arm) => {
    const out: {
      contentTypePattern?: string;
      contentTypeConjuncts?: readonly (readonly string[])[];
      minSizeBytes?: number;
      maxSizeBytes?: number;
      requiredCustomMetadataKeys?: readonly string[];
      ownerMetadataKey?: string;
      httpHeaders?: Readonly<Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>>;
      nullHttpHeaders?: readonly StorageHttpHeaderKey[];
      storedHttpHeaders?: Readonly<
        Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>
      >;
    } = {};
    if (arm.contentTypeConjuncts.length > 0) {
      const pat = formatConjunctsPattern(arm.contentTypeConjuncts);
      if (pat !== undefined) out.contentTypePattern = pat;
      out.contentTypeConjuncts = arm.contentTypeConjuncts.map((c) => [...c]);
    }
    if (arm.minSizeBytes !== undefined) out.minSizeBytes = arm.minSizeBytes;
    if (arm.maxSizeBytes !== undefined) out.maxSizeBytes = arm.maxSizeBytes;
    if (arm.requiredKeys.size > 0) {
      out.requiredCustomMetadataKeys = [...arm.requiredKeys].sort();
    }
    if (ownerMetadataKey !== undefined) out.ownerMetadataKey = ownerMetadataKey;
    const httpHeaders = headerMapToRecord(arm.httpHeaders);
    if (httpHeaders !== undefined) out.httpHeaders = httpHeaders;
    if (arm.nullHttpHeaders.size > 0) out.nullHttpHeaders = [...arm.nullHttpHeaders].sort();
    const storedHttpHeaders = headerMapToRecord(arm.storedHttpHeaders);
    if (storedHttpHeaders !== undefined) out.storedHttpHeaders = storedHttpHeaders;
    return out;
  });

  const anyConstrained = formattedArms.some(
    (a) =>
      a.contentTypePattern !== undefined
      || a.minSizeBytes !== undefined
      || a.maxSizeBytes !== undefined
      || a.requiredCustomMetadataKeys !== undefined
      || a.ownerMetadataKey !== undefined
      || a.httpHeaders !== undefined
      || a.nullHttpHeaders !== undefined
      || a.storedHttpHeaders !== undefined,
  );
  if (!anyConstrained) return undefined;
  return formattedArms;
}

export function extractStorageMetadataConstraint(
  condition: Expression,
  scope: RuleAstScope,
  ownerConditions: readonly OwnerCondition[],
): StorageMetadataConstraint | undefined {
  const summary = summarizeConstraints(condition, scope, false);
  const incomingOwner = ownerConditions.find((c) => c.kind === 'incomingField');
  const storedOwner = ownerConditions.find((c) => c.kind === 'storedField');
  const ownerMetadataKey = incomingOwner?.field ?? storedOwner?.field;

  const out: {
    contentTypePattern?: string;
    contentTypeConjuncts?: readonly (readonly string[])[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
    requiredCustomMetadataKeys?: readonly string[];
    ownerMetadataKey?: string;
    httpHeaders?: Readonly<Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>>;
    nullHttpHeaders?: readonly StorageHttpHeaderKey[];
    storedHttpHeaders?: Readonly<
      Partial<Record<StorageHttpHeaderKey, readonly (readonly string[])[]>>
    >;
  } = {};

  if (!summary.impossible) {
    if (summary.contentTypeConjuncts && summary.contentTypeConjuncts.length > 0) {
      const pat = formatConjunctsPattern(summary.contentTypeConjuncts);
      if (pat !== undefined) out.contentTypePattern = pat;
      if (summary.contentTypeConjuncts.length > 1) {
        out.contentTypeConjuncts = summary.contentTypeConjuncts.map((c) => [...c]);
      }
    }
    if (summary.minSizeBytes !== undefined) out.minSizeBytes = summary.minSizeBytes;
    if (summary.maxSizeBytes !== undefined) out.maxSizeBytes = summary.maxSizeBytes;
    if (summary.requiredKeys.size > 0) {
      out.requiredCustomMetadataKeys = [...summary.requiredKeys].sort();
    }
    const httpHeaders = headerMapToRecord(summary.httpHeaders);
    if (httpHeaders !== undefined) out.httpHeaders = httpHeaders;
    if (summary.nullHttpHeaders.size > 0) {
      out.nullHttpHeaders = [...summary.nullHttpHeaders].sort();
    }
    const storedHttpHeaders = headerMapToRecord(summary.storedHttpHeaders);
    if (storedHttpHeaders !== undefined) out.storedHttpHeaders = storedHttpHeaders;
  }
  if (ownerMetadataKey !== undefined) out.ownerMetadataKey = ownerMetadataKey;

  if (
    out.contentTypePattern === undefined
    && out.minSizeBytes === undefined
    && out.maxSizeBytes === undefined
    && out.requiredCustomMetadataKeys === undefined
    && out.ownerMetadataKey === undefined
    && out.httpHeaders === undefined
    && out.nullHttpHeaders === undefined
    && out.storedHttpHeaders === undefined
  ) {
    return undefined;
  }
  return out;
}
