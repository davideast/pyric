/**
 * Structural trace canonicalization and gap pattern extraction for local
 * Firestore observation (`observe-local-firestore.ts`).
 */
import type { ExprTraceEntry, FunctionDef, RuleEvaluation, TestResult } from 'pyric/rules/internal';
import { ALWAYS_OPEN, type GapPattern } from './observe-local-evaluation.js';
import {
  extractMethodName,
  isAtomicTraceNode,
  isNullTraceNode,
  literalIndexOf,
  literalStringOf,
  parsedRulesOf,
  pathWildcardNamesOf,
  resolveInitialScope,
  stripOuterParens,
  type FunctionScopeMap,
  type ParsedRulesEntry,
} from './observe-local-firestore-scopes.js';

export { parsedRulesOf, type ParsedRulesEntry };

export const RESOURCE_READ = /(?<![\w.])resource\b/;
const AFTER_LOOKUP = /(?<![.\w])(?:getAfter|existsAfter)\s*\(/;
export const WRITE_READ = /\brequest\.resource\b/;
const EMAIL_CLAIM = /\brequest\.auth\.token(?:\.(?:email\b|firebase\.identities\b)|\[['"]email['"]\])/;

/** Gaps checked over non-skipped evaluated expressions in the deciding trace entries. */
export const FIRESTORE_GAPS: readonly GapPattern[] = [
  ['stored-document', RESOURCE_READ, (given) => !given.document],
  ['stored-document', AFTER_LOOKUP, ALWAYS_OPEN],
  ['write-data', WRITE_READ, (given) => !given.writeData],
  ['stored-document', WRITE_READ, (given) => given.writeData && !given.wholeWrite],
  ['claim-values', /\brequest\.auth\.token\b/, (given) => !given.claims],
  ['claim-values', EMAIL_CLAIM, (given) => !given.emailKnown],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

export function decidingTraceEntries(result: TestResult, allowed: boolean): RuleEvaluation[] {
  if (!allowed) return result.trace;
  return result.trace.filter((entry) => entry.verdict === 'ALLOW').slice(0, 1);
}

type CanonValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'path'; readonly path: string }
  | {
      readonly kind: 'map';
      readonly entries: ReadonlyMap<string, CanonValue>;
      readonly dynamicValues: readonly CanonValue[];
    }
  | {
      readonly kind: 'list';
      readonly items: readonly CanonValue[];
      readonly dynamicElement?: CanonValue;
    }
  | { readonly kind: 'union'; readonly options: readonly CanonValue[] };

const NONE_VALUE: CanonValue = { kind: 'none' };

function flattenCanonOptions(value: CanonValue): readonly CanonValue[] {
  if (value.kind === 'none') return [];
  if (value.kind === 'union') return value.options;
  return [value];
}

function unionCanonValues(values: readonly CanonValue[]): CanonValue {
  const flat: CanonValue[] = [];
  for (const v of values) {
    flat.push(...flattenCanonOptions(v));
  }
  if (flat.length === 0) return NONE_VALUE;
  if (flat.length === 1) return flat[0]!;
  return { kind: 'union', options: flat };
}

function allListElements(value: CanonValue): CanonValue {
  const parts: CanonValue[] = [];
  for (const opt of flattenCanonOptions(value)) {
    if (opt.kind === 'list') {
      parts.push(...opt.items);
      if (opt.dynamicElement !== undefined) parts.push(opt.dynamicElement);
    }
  }
  return unionCanonValues(parts);
}

function hasListOption(value: CanonValue): boolean {
  return flattenCanonOptions(value).some((opt) => opt.kind === 'list');
}

function sliceCanonValue(
  value: CanonValue,
  startIdx: number | undefined,
  endIdx: number | undefined,
): CanonValue {
  const results: CanonValue[] = [];
  for (const opt of flattenCanonOptions(value)) {
    if (opt.kind !== 'list') continue;
    if (startIdx !== undefined && endIdx !== undefined) {
      results.push({
        kind: 'list',
        items: opt.items.slice(startIdx, endIdx),
        dynamicElement: opt.dynamicElement,
      });
    } else if (startIdx !== undefined) {
      results.push({
        kind: 'list',
        items: opt.items.slice(startIdx),
        dynamicElement: opt.dynamicElement,
      });
    } else {
      results.push({
        kind: 'list',
        items: [],
        dynamicElement: allListElements(opt),
      });
    }
  }
  return unionCanonValues(results);
}

function concatCanonValues(leftVal: CanonValue, rightVal: CanonValue): CanonValue {
  const leftLists = flattenCanonOptions(leftVal).filter(
    (opt): opt is Extract<CanonValue, { kind: 'list' }> => opt.kind === 'list',
  );
  const rightLists = flattenCanonOptions(rightVal).filter(
    (opt): opt is Extract<CanonValue, { kind: 'list' }> => opt.kind === 'list',
  );
  if (leftLists.length === 0) return NONE_VALUE;
  if (rightLists.length === 0) {
    return {
      kind: 'list',
      items: [],
      dynamicElement: unionCanonValues([allListElements(leftVal), allListElements(rightVal)]),
    };
  }
  const results: CanonValue[] = [];
  for (const l of leftLists) {
    for (const r of rightLists) {
      if (l.dynamicElement === undefined) {
        results.push({
          kind: 'list',
          items: [...l.items, ...r.items],
          dynamicElement: r.dynamicElement,
        });
      } else {
        results.push({
          kind: 'list',
          items: [],
          dynamicElement: unionCanonValues([allListElements(l), allListElements(r)]),
        });
      }
    }
  }
  return unionCanonValues(results);
}

function mapValuesAsList(objVal: CanonValue): CanonValue {
  const parts: CanonValue[] = [];
  let sawMap = false;
  for (const opt of flattenCanonOptions(objVal)) {
    if (opt.kind === 'map') {
      sawMap = true;
      parts.push(...opt.entries.values(), ...opt.dynamicValues);
    }
  }
  if (!sawMap) return NONE_VALUE;
  return { kind: 'list', items: [], dynamicElement: unionCanonValues(parts) };
}

function isEmailContainerPath(canonicalPath: string): boolean {
  return (
    canonicalPath === 'request.auth.token' ||
    canonicalPath === 'request.auth.token.firebase' ||
    canonicalPath === 'request.auth.token.firebase.identities'
  );
}

function containsEmailContainer(value: CanonValue): boolean {
  switch (value.kind) {
    case 'none':
      return false;
    case 'path':
      return isEmailContainerPath(value.path);
    case 'map': {
      for (const entry of value.entries.values()) {
        if (containsEmailContainer(entry)) return true;
      }
      return value.dynamicValues.some(containsEmailContainer);
    }
    case 'list':
      if (value.items.some(containsEmailContainer)) return true;
      return value.dynamicElement !== undefined && containsEmailContainer(value.dynamicElement);
    case 'union':
      return value.options.some(containsEmailContainer);
  }
}

function evaluatedExpressionsOfEntry(
  entry: RuleEvaluation,
  parsed: ParsedRulesEntry | null,
  out: string[],
): void {
  const exprTrace = entry.expressionTrace;
  if (exprTrace === undefined || exprTrace.length === 0) {
    if (entry.conditionText !== undefined) out.push(entry.conditionText);
    return;
  }

  const childrenByParent = new Map<number, number[]>();
  const roots: number[] = [];
  for (let i = 0; i < exprTrace.length; i++) {
    const parent = exprTrace[i]!.parent;
    if (parent === null) {
      roots.push(i);
    } else {
      let list = childrenByParent.get(parent);
      if (!list) {
        list = [];
        childrenByParent.set(parent, list);
      }
      list.push(i);
    }
  }

  const pathVars = pathWildcardNamesOf(entry.matchPath);
  const initialFunctions = resolveInitialScope(entry, parsed);

  const emitPath = (canon: string): CanonValue => {
    out.push(canon);
    return { kind: 'path', path: canon };
  };

  const emitEmbeddedPaths = (val: CanonValue): void => {
    for (const opt of flattenCanonOptions(val)) {
      if (opt.kind === 'path') out.push(opt.path);
    }
  };

  const readProperty = (obj: CanonValue, prop: string): CanonValue => {
    switch (obj.kind) {
      case 'none':
        return NONE_VALUE;
      case 'path':
        return emitPath(`${obj.path}.${prop}`);
      case 'map': {
        const parts: CanonValue[] = [...obj.dynamicValues];
        const direct = obj.entries.get(prop);
        if (direct !== undefined) parts.push(direct);
        const combined = unionCanonValues(parts);
        emitEmbeddedPaths(combined);
        return combined;
      }
      case 'list': {
        if (/^\d+$/.test(prop)) {
          const parts: CanonValue[] = [];
          const item = obj.items[Number(prop)];
          if (item !== undefined) parts.push(item);
          if (obj.dynamicElement !== undefined) parts.push(obj.dynamicElement);
          const combined = unionCanonValues(parts);
          emitEmbeddedPaths(combined);
          return combined;
        }
        return NONE_VALUE;
      }
      case 'union':
        return unionCanonValues(obj.options.map((opt) => readProperty(opt, prop)));
    }
  };

  const readDynamicElement = (obj: CanonValue): CanonValue => {
    if (containsEmailContainer(obj)) {
      out.push('request.auth.token.email');
    }
    switch (obj.kind) {
      case 'list': {
        const combined = allListElements(obj);
        emitEmbeddedPaths(combined);
        return combined;
      }
      case 'map': {
        const combined = unionCanonValues([...obj.entries.values(), ...obj.dynamicValues]);
        emitEmbeddedPaths(combined);
        return combined;
      }
      case 'union':
        return unionCanonValues(obj.options.map(readDynamicElement));
      default:
        return NONE_VALUE;
    }
  };

  const walk = (
    idx: number,
    aliases: ReadonlyMap<string, CanonValue>,
    functions: FunctionScopeMap,
  ): CanonValue => {
    const node = exprTrace[idx];
    if (!node || node.skipped === true) return NONE_VALUE;
    if (parsed === null && isAtomicTraceNode(node)) {
      out.push(stripOuterParens(node.source));
    }
    const children = childrenByParent.get(idx) ?? [];

    switch (node.kind) {
      case 'identifier': {
        const id = stripOuterParens(node.source);
        if (aliases.has(id)) {
          const mapped = aliases.get(id)!;
          emitEmbeddedPaths(mapped);
          return mapped;
        }
        if (!pathVars.has(id) && (id === 'request' || id === 'resource')) {
          return emitPath(id);
        }
        return NONE_VALUE;
      }

      case 'memberAccess': {
        let objVal: CanonValue = NONE_VALUE;
        if (children[0] !== undefined) objVal = walk(children[0], aliases, functions);
        for (const extra of children.slice(1)) walk(extra, aliases, functions);
        const prop = /\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(stripOuterParens(node.source))?.[1];
        if (prop !== undefined) return readProperty(objVal, prop);
        return NONE_VALUE;
      }

      case 'bracketAccess': {
        const idxChild = children[0];
        const objChild = children[1];
        if (idxChild !== undefined) walk(idxChild, aliases, functions);
        let objVal: CanonValue = NONE_VALUE;
        if (objChild !== undefined) objVal = walk(objChild, aliases, functions);
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        let idxNode: ExprTraceEntry | undefined;
        if (idxChild !== undefined) idxNode = exprTrace[idxChild];
        const strKey = literalStringOf(idxNode);
        if (strKey !== undefined) return readProperty(objVal, strKey);
        const numIdx = literalIndexOf(idxNode);
        if (numIdx !== undefined && hasListOption(objVal)) {
          return readProperty(objVal, String(numIdx));
        }
        return readDynamicElement(objVal);
      }

      case 'sliceAccess': {
        let objVal: CanonValue = NONE_VALUE;
        if (children[0] !== undefined) objVal = walk(children[0], aliases, functions);
        for (const extra of children.slice(1)) walk(extra, aliases, functions);
        let startNode: ExprTraceEntry | undefined;
        if (children[1] !== undefined) startNode = exprTrace[children[1]];
        let endNode: ExprTraceEntry | undefined;
        if (children[2] !== undefined) endNode = exprTrace[children[2]];
        return sliceCanonValue(objVal, literalIndexOf(startNode), literalIndexOf(endNode));
      }

      case 'listLiteral': {
        const items = children.map((childIdx) => walk(childIdx, aliases, functions));
        return { kind: 'list', items };
      }

      case 'mapLiteral': {
        const entries = new Map<string, CanonValue>();
        const dynamicValues: CanonValue[] = [];
        for (let i = 0; i < children.length; i += 2) {
          const keyIdx = children[i];
          const valIdx = children[i + 1];
          if (keyIdx !== undefined) walk(keyIdx, aliases, functions);
          let val: CanonValue = NONE_VALUE;
          if (valIdx !== undefined) val = walk(valIdx, aliases, functions);
          let keyNode: ExprTraceEntry | undefined;
          if (keyIdx !== undefined) keyNode = exprTrace[keyIdx];
          const keyStr = literalStringOf(keyNode);
          if (keyStr !== undefined) {
            entries.set(keyStr, val);
          } else {
            dynamicValues.push(val);
          }
        }
        return { kind: 'map', entries, dynamicValues };
      }

      case 'inExpr': {
        const collChild = children[0];
        const elemChild = children[1];
        let collVal: CanonValue = NONE_VALUE;
        if (collChild !== undefined) collVal = walk(collChild, aliases, functions);
        let elemVal: CanonValue = NONE_VALUE;
        if (elemChild !== undefined) elemVal = walk(elemChild, aliases, functions);
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        if (containsEmailContainer(elemVal)) {
          out.push('request.auth.token.email');
        }
        let elemNode: ExprTraceEntry | undefined;
        if (elemChild !== undefined) elemNode = exprTrace[elemChild];
        const key = literalStringOf(elemNode);
        if (key !== undefined) {
          readProperty(collVal, key);
          if (hasListOption(collVal) && containsEmailContainer(collVal)) {
            out.push('request.auth.token.email');
          }
        } else if (containsEmailContainer(collVal)) {
          out.push('request.auth.token.email');
        }
        return NONE_VALUE;
      }

      case 'methodCall': {
        const objChild = children[0];
        const argChildren = children.slice(1);
        let objVal: CanonValue = NONE_VALUE;
        if (objChild !== undefined) objVal = walk(objChild, aliases, functions);
        const argVals = argChildren.map((argIdx) => walk(argIdx, aliases, functions));
        if (objChild === undefined) return NONE_VALUE;
        const method = extractMethodName(node.source);
        if (method === 'get') {
          let firstArg: ExprTraceEntry | undefined;
          if (argChildren[0] !== undefined) firstArg = exprTrace[argChildren[0]];
          const defaultVal = argVals[1] ?? NONE_VALUE;
          const strKey = literalStringOf(firstArg);
          if (strKey !== undefined) {
            return unionCanonValues([readProperty(objVal, strKey), defaultVal]);
          }
          if (
            Array.isArray(firstArg?.value) &&
            firstArg.value.length > 0 &&
            firstArg.value.every((part) => typeof part === 'string')
          ) {
            let cur = objVal;
            for (const part of firstArg.value as string[]) {
              cur = readProperty(cur, part);
            }
            return unionCanonValues([cur, defaultVal]);
          }
          if (containsEmailContainer(objVal)) {
            out.push('request.auth.token.email');
          }
          return unionCanonValues([readDynamicElement(objVal), defaultVal]);
        }
        if (method === 'concat') {
          return concatCanonValues(objVal, argVals[0] ?? NONE_VALUE);
        }
        if (method === 'values') {
          if (containsEmailContainer(objVal)) out.push('request.auth.token.email');
          return mapValuesAsList(objVal);
        }
        if (method === 'removeAll') {
          if (containsEmailContainer(objVal) || argVals.some(containsEmailContainer)) {
            out.push('request.auth.token.email');
          }
          if (hasListOption(objVal)) {
            return { kind: 'list', items: [], dynamicElement: allListElements(objVal) };
          }
          return NONE_VALUE;
        }
        if (
          method === 'toSet' ||
          method === 'union' ||
          method === 'intersection' ||
          method === 'difference'
        ) {
          if (containsEmailContainer(objVal) || argVals.some(containsEmailContainer)) {
            out.push('request.auth.token.email');
          }
          const combined = unionCanonValues([allListElements(objVal), ...argVals.map(allListElements)]);
          if (combined.kind !== 'none') {
            return { kind: 'list', items: [], dynamicElement: combined };
          }
          return NONE_VALUE;
        }
        if (method === 'keys' || method === 'size') {
          if (containsEmailContainer(objVal)) out.push('request.auth.token.email');
        } else if (
          method === 'diff' ||
          method === 'hasAny' ||
          method === 'hasAll' ||
          method === 'hasOnly'
        ) {
          if (containsEmailContainer(objVal) || argVals.some(containsEmailContainer)) {
            out.push('request.auth.token.email');
          }
        }
        return NONE_VALUE;
      }

      case 'binaryOp': {
        const leftIdx = children[0];
        const rightIdx = children[1];
        let leftVal: CanonValue = NONE_VALUE;
        if (leftIdx !== undefined) leftVal = walk(leftIdx, aliases, functions);
        let rightVal: CanonValue = NONE_VALUE;
        if (rightIdx !== undefined) rightVal = walk(rightIdx, aliases, functions);
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        if (node.operator === '==' || node.operator === '!=') {
          let leftNode: ExprTraceEntry | undefined;
          if (leftIdx !== undefined) leftNode = exprTrace[leftIdx];
          let rightNode: ExprTraceEntry | undefined;
          if (rightIdx !== undefined) rightNode = exprTrace[rightIdx];
          const leftNull = isNullTraceNode(leftNode);
          const rightNull = isNullTraceNode(rightNode);
          if (
            (containsEmailContainer(leftVal) && !rightNull) ||
            (containsEmailContainer(rightVal) && !leftNull)
          ) {
            out.push('request.auth.token.email');
          }
        }
        return NONE_VALUE;
      }

      case 'functionCall': {
        const callName = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(stripOuterParens(node.source))?.[1];
        let candidates: readonly FunctionDef[] | undefined;
        if (callName !== undefined) {
          candidates = functions.get(callName);
        }
        if (candidates !== undefined && candidates.length > 0) {
          const viable = candidates.filter((fn) => fn.parameters.length <= children.length);
          const defsToWalk = viable.length > 0 ? viable : candidates;
          const results: CanonValue[] = [];
          for (const fnDef of defsToWalk) {
            const calleeAliases = new Map<string, CanonValue>();
            const argCount = Math.min(fnDef.parameters.length, children.length);
            for (let i = 0; i < argCount; i++) {
              const argVal = walk(children[i]!, aliases, functions);
              calleeAliases.set(fnDef.parameters[i]!, argVal);
            }
            const calleeFunctions = parsed?.fnLexicalScopes.get(fnDef) ?? functions;
            let bodyVal: CanonValue = NONE_VALUE;
            for (const childIdx of children.slice(argCount)) {
              const childVal = walk(childIdx, calleeAliases, calleeFunctions);
              const letName = exprTrace[childIdx]?.letBinding?.name;
              if (letName) {
                calleeAliases.set(letName, childVal);
              } else {
                bodyVal = childVal;
              }
            }
            results.push(bodyVal);
          }
          return unionCanonValues(results);
        }
        if (callName === 'getAfter' || callName === 'existsAfter') {
          out.push(`${callName}(`);
        }
        const localAliases = new Map(aliases);
        let lastVal: CanonValue = NONE_VALUE;
        for (const childIdx of children) {
          const childVal = walk(childIdx, localAliases, functions);
          const letName = exprTrace[childIdx]?.letBinding?.name;
          if (letName) {
            localAliases.set(letName, childVal);
          } else {
            lastVal = childVal;
          }
        }
        return lastVal;
      }

      case 'ternary': {
        if (children[0] !== undefined) walk(children[0], aliases, functions);
        const branchVals = children.slice(1).map((branchIdx) => walk(branchIdx, aliases, functions));
        return unionCanonValues(branchVals);
      }

      default: {
        for (const childIdx of children) walk(childIdx, aliases, functions);
        return NONE_VALUE;
      }
    }
  };

  for (const rootIdx of roots) {
    walk(rootIdx, new Map(), initialFunctions);
  }
}

export function evaluatedExpressionsOf(
  entries: readonly RuleEvaluation[],
  parsed: ParsedRulesEntry | null,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    evaluatedExpressionsOfEntry(entry, parsed, out);
  }
  return out;
}
