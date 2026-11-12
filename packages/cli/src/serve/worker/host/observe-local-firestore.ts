/**
 * The local Firestore rules' verdict on an observed Firestore call.
 *
 * The host runs the call through the deployed rules' simulator with the
 * claim values, written data, call-carried document, and pre-operation
 * `observedSession` documents. A Firestore verdict keeps the simulator's
 * trace, as a sandbox request's `rulesEvidence` does. `pyric verify` replays
 * captured live calls through `evaluateFirestoreCall` with candidate rules.
 */
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
  Bytes,
  checkRulesSource,
  EXISTS_ONLY_DOC,
  indexRulesetScopes,
  LatLng,
  normalizeDocumentPath,
  projectEvaluatedRule,
  readAuthoredSourceMap,
  Reference,
  renderMatchBlockPath,
  rootBlockGovernsEveryDocument,
  rootGovernsEveryDocument,
  SimulateFirestoreRulesHandler,
  Timestamp,
  topLevelMatches,
  Vector,
  type AllowRule,
  type AuthoredSourceMap,
  type DocumentLookupMeta,
  type Expression,
  type ExprTraceEntry,
  type FirestoreRules,
  type FunctionDef,
  type MatchBlock,
  type RuleEvaluation,
  type SimulationContext,
  type TestCase,
  type TestResult,
} from 'pyric/rules/internal';
import { captureRulesEvidence, getInternalEnv, type ObservedMethod } from 'pyric/sandbox/internal';
import type { ObservedCall } from 'pyric/sandbox';
import type { ObservedFirestoreDocLookup } from '../../observed-session/coverage.js';
import type { ObservedSessionDataStore } from '../../observed-session/store.js';
import type { HostCtx } from '../host-context.js';
import {
  ALWAYS_OPEN,
  authOf,
  definedOnly,
  gapsIn,
  givenBy,
  isPlainRecord,
  unionOf,
  unionPaths,
  verdictOf,
  type Evaluation,
  type GapPattern,
  type Given,
  type LocalVerdict,
} from './observe-local-evaluation.js';

const LOCAL_TRACE_VERSION = 'local-rules';
const SYNTHETIC_LIST_DOC_SEGMENTS: ReadonlySet<string> = new Set([
  '__hypothetical_doc__',
  '__listPlaceholder__',
]);

const RESOURCE_READ = /(?<![\w.])resource\b/;
const AFTER_LOOKUP = /(?<![.\w])(?:getAfter|existsAfter)\s*\(/;
const WRITE_READ = /\brequest\.resource\b/;
const EMAIL_CLAIM = /\brequest\.auth\.token(?:\.(?:email\b|firebase\.identities\b)|\[['"]email['"]\])/;

/** Gaps checked over non-skipped evaluated expressions in the deciding trace entries. */
const FIRESTORE_GAPS: readonly GapPattern[] = [
  ['stored-document', RESOURCE_READ, (given) => !given.document],
  ['stored-document', AFTER_LOOKUP, ALWAYS_OPEN],
  ['write-data', WRITE_READ, (given) => !given.writeData],
  ['stored-document', WRITE_READ, (given) => given.writeData && !given.wholeWrite],
  ['claim-values', /\brequest\.auth\.token\b/, (given) => !given.claims],
  ['claim-values', EMAIL_CLAIM, (given) => !given.emailKnown],
  ['query', /\brequest\.query\b/, ALWAYS_OPEN],
];

interface ParsedRulesEntry {
  readonly source: string;
  readonly ast: FirestoreRules | null;
  readonly sourceMap: AuthoredSourceMap;
  readonly functionsByMatchPath: ReadonlyMap<string, ReadonlyMap<string, FunctionDef>>;
  readonly fnLexicalScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>;
  readonly allFunctions: ReadonlyMap<string, FunctionDef>;
}

const collectionGroupSimulator = new SimulateFirestoreRulesHandler();
let cachedParsedRules: ParsedRulesEntry | null = null;

function indexFunctionMaps(ast: FirestoreRules): {
  functionsByMatchPath: Map<string, Map<string, FunctionDef>>;
  fnLexicalScopes: Map<FunctionDef, Map<string, FunctionDef>>;
  allFunctions: Map<string, FunctionDef>;
} {
  const functionsByMatchPath = new Map<string, Map<string, FunctionDef>>();
  const fnLexicalScopes = new Map<FunctionDef, Map<string, FunctionDef>>();
  const allFunctions = new Map<string, FunctionDef>();

  const rootScope = new Map<string, FunctionDef>();
  for (const fn of ast.functions ?? []) {
    rootScope.set(fn.name, fn);
    allFunctions.set(fn.name, fn);
  }
  for (const fn of ast.service.functions ?? []) {
    rootScope.set(fn.name, fn);
    allFunctions.set(fn.name, fn);
  }
  for (const fn of rootScope.values()) {
    fnLexicalScopes.set(fn, rootScope);
  }

  const visitBlock = (block: MatchBlock, outer: ReadonlyMap<string, FunctionDef>, prefix: string): void => {
    const scope = new Map(outer);
    for (const fn of block.functions) {
      scope.set(fn.name, fn);
      allFunctions.set(fn.name, fn);
    }
    for (const fn of block.functions) {
      fnLexicalScopes.set(fn, scope);
    }
    const ownPath = renderMatchBlockPath(block);
    const fullPath = prefix === '' ? ownPath : `${prefix}${ownPath}`;
    functionsByMatchPath.set(ownPath, scope);
    functionsByMatchPath.set(fullPath, scope);
    for (const child of block.children) {
      visitBlock(child, scope, fullPath);
    }
  };

  for (const rootBlock of topLevelMatches(ast.service)) {
    const rootScopeWithBlock = new Map(rootScope);
    for (const fn of rootBlock.functions) {
      rootScopeWithBlock.set(fn.name, fn);
      allFunctions.set(fn.name, fn);
    }
    for (const fn of rootBlock.functions) {
      fnLexicalScopes.set(fn, rootScopeWithBlock);
    }
    functionsByMatchPath.set(renderMatchBlockPath(rootBlock), rootScopeWithBlock);
    for (const child of rootBlock.children) {
      visitBlock(child, rootScopeWithBlock, '');
    }
  }

  return { functionsByMatchPath, fnLexicalScopes, allFunctions };
}

function parsedRulesOf(source: string | undefined): ParsedRulesEntry | null {
  if (source === undefined) return null;
  if (cachedParsedRules?.source === source) return cachedParsedRules;
  const checked = checkRulesSource(source);
  const ast = checked.ok ? checked.ast : null;
  const sourceMap = readAuthoredSourceMap(source);
  if (ast === null) {
    cachedParsedRules = {
      source,
      ast: null,
      sourceMap,
      functionsByMatchPath: new Map(),
      fnLexicalScopes: new Map(),
      allFunctions: new Map(),
    };
    return cachedParsedRules;
  }
  indexRulesetScopes(ast);
  const indexed = indexFunctionMaps(ast);
  cachedParsedRules = {
    source,
    ast,
    sourceMap,
    ...indexed,
  };
  return cachedParsedRules;
}

function groupBindings(block: MatchBlock, collectionId: string): Set<string> | null {
  const [first, second, third, ...rest] = block.path.segments;
  if (first?.type !== 'recursive') return null;
  if (!second) return new Set([first.name]);
  if (
    second.type === 'literal' &&
    second.value === collectionId &&
    third?.type === 'wildcard' &&
    rest.length === 0
  ) {
    return new Set([first.name, third.name]);
  }
  return null;
}

function projectPathInvariantCondition(
  expr: Expression,
  bound: ReadonlySet<string>,
  functions: ReadonlyMap<string, FunctionDef>,
  ambiguousNames: ReadonlySet<string>,
): { condition: Expression; requiredFunctionDefs: ReadonlySet<FunctionDef> } | null {
  const analysis = analyzeListRulePathInvariance(expr, bound, functions, ambiguousNames);
  if (analysis.pathInvariant) {
    return { condition: expr, requiredFunctionDefs: analysis.requiredFunctionDefs };
  }
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = expr.operand;
    if (inner.type === 'binaryOp' && inner.op === '&&') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '||',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'binaryOp' && inner.op === '||') {
      return projectPathInvariantCondition(
        {
          type: 'binaryOp',
          op: '&&',
          left: { type: 'unaryOp', op: '!', operand: inner.left },
          right: { type: 'unaryOp', op: '!', operand: inner.right },
        },
        bound,
        functions,
        ambiguousNames,
      );
    }
    if (inner.type === 'unaryOp' && inner.op === '!') {
      const sub = projectPathInvariantCondition(inner.operand, bound, functions, ambiguousNames);
      if (!sub) return null;
      return {
        condition: { type: 'unaryOp', op: '!', operand: { type: 'unaryOp', op: '!', operand: sub.condition } },
        requiredFunctionDefs: sub.requiredFunctionDefs,
      };
    }
  }
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    const left = projectPathInvariantCondition(expr.left, bound, functions, ambiguousNames);
    const right = projectPathInvariantCondition(expr.right, bound, functions, ambiguousNames);
    if (left && right) {
      return {
        condition: { ...expr, left: left.condition, right: right.condition },
        requiredFunctionDefs: new Set([...left.requiredFunctionDefs, ...right.requiredFunctionDefs]),
      };
    }
    if (expr.op === '||') {
      return left ?? right;
    }
  }
  return null;
}

function projectGroupBlock(
  block: MatchBlock,
  collectionId: string,
  outerFunctions: readonly FunctionDef[],
  requiredFunctionDefs: Set<FunctionDef>,
): MatchBlock | null {
  const bound = groupBindings(block, collectionId);
  if (!bound) return null;

  const functionScope = buildListRuleFunctionScope([...outerFunctions, ...block.functions]);
  const blockRequiredDefs = new Set<FunctionDef>();
  const allows: AllowRule[] = [];

  for (const rule of block.allows) {
    if (!rule.operations.some((operation) => operation === 'list' || operation === 'read')) {
      continue;
    }
    const projected = projectPathInvariantCondition(
      rule.condition,
      bound,
      functionScope.functions,
      functionScope.ambiguousNames,
    );
    if (!projected) continue;
    for (const fnDef of projected.requiredFunctionDefs) {
      if (block.functions.includes(fnDef)) {
        blockRequiredDefs.add(fnDef);
      } else {
        requiredFunctionDefs.add(fnDef);
      }
    }
    allows.push(projected.condition === rule.condition ? rule : { ...rule, condition: projected.condition });
  }
  if (allows.length === 0) return null;

  return {
    ...block,
    functions: block.functions.filter((fn) => blockRequiredDefs.has(fn)),
    allows,
    children: [],
  };
}

function projectCollectionGroupRules(ast: FirestoreRules, collectionId: string): FirestoreRules | null {
  if (!rootGovernsEveryDocument(ast)) return null;
  indexRulesetScopes(ast);

  const serviceFunctions = [...(ast.functions ?? []), ...(ast.service.functions ?? [])];
  const requiredFunctionDefs = new Set<FunctionDef>();
  const retainRequired = (functions: readonly FunctionDef[] | undefined): FunctionDef[] | undefined =>
    functions?.filter((fn) => requiredFunctionDefs.has(fn));

  const projectedRoots: MatchBlock[] = [];
  for (const rootBlock of topLevelMatches(ast.service)) {
    if (!rootBlockGovernsEveryDocument(rootBlock, ast.version)) continue;
    const outerFunctions = [...serviceFunctions, ...rootBlock.functions];
    const children: MatchBlock[] = [];
    for (const block of rootBlock.children) {
      const projected = projectGroupBlock(block, collectionId, outerFunctions, requiredFunctionDefs);
      if (projected) children.push(projected);
    }
    if (children.length === 0) continue;
    projectedRoots.push({
      ...rootBlock,
      functions: retainRequired(rootBlock.functions) ?? [],
      children,
    });
  }
  if (projectedRoots.length === 0) return null;

  return {
    ...ast,
    functions: retainRequired(ast.functions),
    service: {
      ...ast.service,
      functions: retainRequired(ast.service.functions),
      match: projectedRoots[0]!,
      matches: projectedRoots,
    },
  };
}

const FORBIDDEN_SESSION_DOC_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function defineOwnDocField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function decodeStandardBase64(encoded: string): Uint8Array {
  const bin = atob(encoded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rehydrateSessionEntriesForRules(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (FORBIDDEN_SESSION_DOC_KEYS.has(k)) continue;
    defineOwnDocField(out, k, rehydrateSessionValueForRules(v));
  }
  return out;
}

function rehydrateSessionValueForRules(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => rehydrateSessionValueForRules(item));
  }
  if (!isPlainRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 2 && value.type === 'pyric/map/1.0' && isPlainRecord(value.fields)) {
    return { type: 'pyric/map/1.0', fields: rehydrateSessionEntriesForRules(value.fields) };
  }
  if (keys.length === 2 && value.type === 'pyric/number/1.0') {
    if (value.value === 'NaN') return Number.NaN;
    if (value.value === 'Infinity') return Number.POSITIVE_INFINITY;
    if (value.value === '-Infinity') return Number.NEGATIVE_INFINITY;
    if (value.value === '-0') return -0;
  }
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/timestamp/1.0')) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  ) {
    try {
      return new Timestamp(Math.trunc(value.seconds), Math.trunc(value.nanoseconds));
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    (keys.length === 2 || (keys.length === 3 && value.type === 'firestore/geoPoint/1.0')) &&
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number'
  ) {
    try {
      return new LatLng(value.latitude, value.longitude);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (keys.length === 2 && value.type === 'firestore/bytes/1.0' && typeof value.bytes === 'string') {
    try {
      return new Bytes(decodeStandardBase64(value.bytes));
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    keys.length === 2 &&
    value.__type__ === '__vector__' &&
    Array.isArray(value.value) &&
    value.value.every((n) => typeof n === 'number')
  ) {
    try {
      return new Vector(value.value as number[]);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    keys.length === 2 &&
    value.type === 'firestore/vectorValue/1.0' &&
    Array.isArray(value.vectorValues) &&
    value.vectorValues.every((n) => typeof n === 'number')
  ) {
    try {
      return new Vector(value.vectorValues as number[]);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  if (
    ((keys.length === 3 || (keys.length === 4 && typeof value.databaseId === 'string')) &&
      value.type === 'document' &&
      typeof value.path === 'string' &&
      typeof value.id === 'string') ||
    ((keys.length === 2 || (keys.length === 3 && typeof value.databaseId === 'string')) &&
      value.__type === 'reference' &&
      typeof value.path === 'string')
  ) {
    try {
      const rawPath = value.path as string;
      const normalizedPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
      const databaseId = typeof value.databaseId === 'string' ? value.databaseId : undefined;
      return new Reference(normalizedPath, databaseId);
    } catch {
      return rehydrateSessionEntriesForRules(value);
    }
  }
  return rehydrateSessionEntriesForRules(value);
}

function rehydrateSessionDocForRules(data: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(data);
  if (keys.length === 2 && data.type === 'pyric/map/1.0' && isPlainRecord(data.fields)) {
    return { type: 'pyric/map/1.0', fields: rehydrateSessionEntriesForRules(data.fields) };
  }
  return rehydrateSessionEntriesForRules(data);
}

interface ResolvedTargetDoc {
  readonly status: ObservedFirestoreDocLookup['status'];
  readonly data?: Record<string, unknown>;
}

function resolveTargetDoc(
  call: ObservedCall,
  path: string,
  method: ObservedMethod,
  observedSession: ObservedSessionDataStore | undefined,
): ResolvedTargetDoc {
  if (call.document !== undefined) {
    return { status: 'complete', data: call.document };
  }
  if (method === 'list' || observedSession === undefined) {
    return { status: 'unobserved' };
  }
  const resolved = observedSession.getFirestoreDoc(path);
  if (resolved.status === 'complete') {
    return { status: 'complete', data: rehydrateSessionDocForRules(resolved.data) };
  }
  return resolved;
}

function isKnownFirestoreUpdate(
  method: Exclude<ObservedMethod, 'set'>,
  call: ObservedCall,
  targetDoc: ResolvedTargetDoc,
): boolean {
  return (
    method === 'update' &&
    isPlainRecord(call.writeData) &&
    targetDoc.status === 'complete' &&
    call.method === 'updateDoc'
  );
}

function buildFirestoreTestCase(
  call: ObservedCall,
  path: string,
  method: Exclude<ObservedMethod, 'set'>,
  targetDoc: ResolvedTargetDoc,
): TestCase {
  const isWrite = method === 'create' || method === 'update';
  const hasStoredResource = method !== 'create' && targetDoc.status === 'complete';
  const testCase: TestCase = {
    description: `${method} ${path}`,
    expectation: 'ALLOW',
    method,
    path,
    auth: authOf(call),
    requestTime: new Date(call.at).toISOString(),
  };
  if (isWrite && isPlainRecord(call.writeData)) {
    testCase.data = call.writeData;
  }
  if (hasStoredResource && targetDoc.data !== undefined) {
    testCase.resource = targetDoc.data;
  }
  if (isKnownFirestoreUpdate(method, call, targetDoc)) {
    testCase.writeMode = { kind: 'update' };
  }
  return testCase;
}

function decidingTraceEntries(result: TestResult, allowed: boolean): RuleEvaluation[] {
  if (!allowed) return result.trace;
  return result.trace.filter((entry) => entry.verdict === 'ALLOW').slice(0, 1);
}

function isAtomicTraceNode(node: ExprTraceEntry): boolean {
  if (node.skipped === true) return false;
  return (
    node.kind === 'identifier' ||
    node.kind === 'memberAccess' ||
    node.kind === 'bracketAccess' ||
    node.kind === 'functionCall'
  );
}

function pathWildcardNamesOf(matchPath: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!matchPath) return names;
  const pattern = /\{([A-Za-z_][A-Za-z0-9_]*)(?:=\*\*)?\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(matchPath)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

function literalStringOf(node: ExprTraceEntry | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.value === 'string') return node.value;
  if (node.kind !== 'literal') return undefined;
  const trimmed = node.source.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function isEmailContainerPath(canonicalPath: string | undefined): boolean {
  return (
    canonicalPath === 'request.auth.token' ||
    canonicalPath === 'request.auth.token.firebase.identities'
  );
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
  const initialFunctions =
    (entry.matchPath ? parsed?.functionsByMatchPath.get(entry.matchPath) : undefined) ??
    parsed?.allFunctions ??
    new Map<string, FunctionDef>();

  const emitCanonical = (canon: string | undefined): string | undefined => {
    if (canon) out.push(canon);
    return canon;
  };

  const walk = (
    idx: number,
    aliases: ReadonlyMap<string, string>,
    functions: ReadonlyMap<string, FunctionDef>,
  ): string | undefined => {
    const node = exprTrace[idx];
    if (!node || node.skipped === true) return undefined;
    if (parsed === null && isAtomicTraceNode(node)) {
      out.push(node.source);
    }
    const children = childrenByParent.get(idx) ?? [];

    switch (node.kind) {
      case 'identifier': {
        const id = node.source.trim();
        if (aliases.has(id)) {
          const mapped = aliases.get(id)!;
          return mapped === '' ? undefined : emitCanonical(mapped);
        }
        if (!pathVars.has(id) && (id === 'request' || id === 'resource')) {
          return emitCanonical(id);
        }
        return undefined;
      }

      case 'memberAccess': {
        const objCanon = children[0] !== undefined ? walk(children[0], aliases, functions) : undefined;
        for (const extra of children.slice(1)) walk(extra, aliases, functions);
        const prop = /\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(node.source)?.[1];
        if (objCanon && prop) {
          return emitCanonical(`${objCanon}.${prop}`);
        }
        return undefined;
      }

      case 'bracketAccess': {
        // Production/simulator evaluates [index, object] in that order.
        const idxChild = children[0];
        const objChild = children[1];
        if (idxChild !== undefined) walk(idxChild, aliases, functions);
        const objCanon = objChild !== undefined ? walk(objChild, aliases, functions) : undefined;
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        const key = literalStringOf(idxChild !== undefined ? exprTrace[idxChild] : undefined);
        if (objCanon && key !== undefined) {
          return emitCanonical(`${objCanon}.${key}`);
        }
        if (isEmailContainerPath(objCanon) && key === undefined) {
          out.push('request.auth.token.email');
        }
        return undefined;
      }

      case 'inExpr': {
        // Production/simulator evaluates [collection, element] in that order.
        const collChild = children[0];
        const elemChild = children[1];
        const collCanon = collChild !== undefined ? walk(collChild, aliases, functions) : undefined;
        if (elemChild !== undefined) walk(elemChild, aliases, functions);
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        const key = literalStringOf(elemChild !== undefined ? exprTrace[elemChild] : undefined);
        if (collCanon && key !== undefined) {
          out.push(`${collCanon}.${key}`);
        } else if (isEmailContainerPath(collCanon)) {
          out.push('request.auth.token.email');
        }
        return undefined;
      }

      case 'methodCall': {
        const objChild = children[0];
        const argChildren = children.slice(1);
        const objCanon = objChild !== undefined ? walk(objChild, aliases, functions) : undefined;
        for (const argIdx of argChildren) walk(argIdx, aliases, functions);
        if (!objCanon || objChild === undefined) return undefined;
        const objSource = exprTrace[objChild]?.source ?? '';
        const tail = node.source.startsWith(objSource) ? node.source.slice(objSource.length) : node.source;
        const method = /^\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(tail)?.[1];
        if (method === 'get') {
          const firstArg = argChildren[0] !== undefined ? exprTrace[argChildren[0]] : undefined;
          const strKey = literalStringOf(firstArg);
          if (strKey !== undefined) {
            return emitCanonical(`${objCanon}.${strKey}`);
          }
          if (
            Array.isArray(firstArg?.value) &&
            firstArg.value.length > 0 &&
            firstArg.value.every((part) => typeof part === 'string')
          ) {
            return emitCanonical(`${objCanon}.${(firstArg.value as string[]).join('.')}`);
          }
          if (isEmailContainerPath(objCanon)) {
            out.push('request.auth.token.email');
          }
          return undefined;
        }
        if (
          (method === 'keys' || method === 'values' || method === 'size' || method === 'diff') &&
          isEmailContainerPath(objCanon)
        ) {
          out.push('request.auth.token.email');
        }
        return undefined;
      }

      case 'binaryOp': {
        const leftIdx = children[0];
        const rightIdx = children[1];
        const leftCanon = leftIdx !== undefined ? walk(leftIdx, aliases, functions) : undefined;
        const rightCanon = rightIdx !== undefined ? walk(rightIdx, aliases, functions) : undefined;
        for (const extra of children.slice(2)) walk(extra, aliases, functions);
        if (node.operator === '==' || node.operator === '!=') {
          const leftNull = leftIdx !== undefined && exprTrace[leftIdx]?.source.trim() === 'null';
          const rightNull = rightIdx !== undefined && exprTrace[rightIdx]?.source.trim() === 'null';
          if ((isEmailContainerPath(leftCanon) && !rightNull) || (isEmailContainerPath(rightCanon) && !leftNull)) {
            out.push('request.auth.token.email');
          }
        }
        return undefined;
      }

      case 'functionCall': {
        const callName = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(node.source.trim())?.[1];
        const fnDef = callName ? functions.get(callName) : undefined;
        if (fnDef) {
          const calleeAliases = new Map<string, string>();
          const argCount = Math.min(fnDef.parameters.length, children.length);
          for (let i = 0; i < argCount; i++) {
            const argCanon = walk(children[i]!, aliases, functions);
            calleeAliases.set(fnDef.parameters[i]!, argCanon ?? '');
          }
          const calleeFunctions = parsed?.fnLexicalScopes.get(fnDef) ?? functions;
          let bodyCanon: string | undefined;
          for (const childIdx of children.slice(argCount)) {
            const childCanon = walk(childIdx, calleeAliases, calleeFunctions);
            const letName = exprTrace[childIdx]?.letBinding?.name;
            if (letName) {
              calleeAliases.set(letName, childCanon ?? '');
            } else {
              bodyCanon = childCanon;
            }
          }
          return bodyCanon;
        }
        if (callName === 'getAfter' || callName === 'existsAfter') {
          out.push(`${callName}(`);
        }
        const localAliases = new Map(aliases);
        let lastCanon: string | undefined;
        for (const childIdx of children) {
          const childCanon = walk(childIdx, localAliases, functions);
          const letName = exprTrace[childIdx]?.letBinding?.name;
          if (letName) {
            localAliases.set(letName, childCanon ?? '');
          } else {
            lastCanon = childCanon;
          }
        }
        return lastCanon;
      }

      case 'ternary': {
        const condChild = children[0];
        if (condChild !== undefined) walk(condChild, aliases, functions);
        let branchCanon: string | undefined;
        for (const branchIdx of children.slice(1)) {
          const canon = walk(branchIdx, aliases, functions);
          if (canon !== undefined) branchCanon = canon;
        }
        return branchCanon;
      }

      default: {
        for (const childIdx of children) walk(childIdx, aliases, functions);
        return undefined;
      }
    }
  };

  for (const rootIdx of roots) {
    walk(rootIdx, new Map(), initialFunctions);
  }
}

function evaluatedExpressionsOf(
  entries: readonly RuleEvaluation[],
  parsed: ParsedRulesEntry | null,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    evaluatedExpressionsOfEntry(entry, parsed, out);
  }
  return out;
}

function hasAppFirestoreRules(ctx: HostCtx, source: string): boolean {
  const loaded = ctx.activeRules?.firestore?.source;
  return typeof loaded === 'string' && loaded === source;
}

/**
 * A Firestore rules simulator with its rules bound: the host's deployed
 * rules' cached parse, or `pyric verify`'s candidate rules.
 */
export type FirestoreSimulate = (
  cases: TestCase[],
  lookups: { getDoc: NonNullable<SimulationContext['getDoc']> },
) => { success: true; data: { results: TestResult[] } } | { success: false };

function evaluateFirestore(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  path: string,
  method: Exclude<ObservedMethod, 'set'>,
  baseGiven: Given,
  observedSession: ObservedSessionDataStore | undefined,
  parsed: ParsedRulesEntry | null,
): Evaluation | undefined {
  const isCollectionGroup = method === 'list' && call.query?.scope === 'collection-group';
  let effectivePath = path;
  let effectiveSimulate = simulate;

  if (isCollectionGroup && parsed !== null) {
    if (parsed.ast === null) return undefined;
    if (path.includes('/')) {
      return { allowed: false, rule: undefined, needs: [], missingPaths: [] };
    }
    const projectedAst = projectCollectionGroupRules(parsed.ast, path);
    if (projectedAst === null) {
      return { allowed: false, rule: undefined, needs: [], missingPaths: [] };
    }
    effectivePath = `${path}/__listPlaceholder__`;
    effectiveSimulate = (cases, lookups) =>
      collectionGroupSimulator.simulateParsed(projectedAst, parsed.source, cases, {
        ...lookups,
        sourceMap: parsed.sourceMap,
        skipQueryProof: true,
      });
  }

  const targetDoc = resolveTargetDoc(call, effectivePath, method, observedSession);
  const targetResourceKnown =
    targetDoc.status === 'complete' || (targetDoc.status === 'absent' && method !== 'update');
  const given: Given = {
    ...baseGiven,
    document: baseGiven.document || targetResourceKnown,
    wholeWrite: baseGiven.wholeWrite || isKnownFirestoreUpdate(method, call, targetDoc),
  };

  const missingByTrace = new WeakMap<readonly ExprTraceEntry[], string[]>();
  let fallbackMissing: string[] = [];

  const recordMissing = (lookupPath: string, lookup: DocumentLookupMeta | undefined): void => {
    const entries = lookup?.trace?.entries;
    if (entries === undefined) {
      fallbackMissing = unionPaths(fallbackMissing, [lookupPath]);
      return;
    }
    const existing = missingByTrace.get(entries);
    missingByTrace.set(entries, unionPaths(existing, [lookupPath]));
  };

  const getDoc: NonNullable<SimulationContext['getDoc']> = (rawLookupPath, lookup) => {
    const normalized = normalizeDocumentPath(rawLookupPath);
    if (
      method === 'list' &&
      normalized.split('/').some((seg) => SYNTHETIC_LIST_DOC_SEGMENTS.has(seg))
    ) {
      return null;
    }
    if (observedSession === undefined) {
      recordMissing(normalized, lookup);
      return null;
    }
    const resolved = observedSession.getFirestoreDoc(normalized);
    if (resolved.status === 'complete') return rehydrateSessionDocForRules(resolved.data);
    if (resolved.status === 'absent') return null;
    if (resolved.status === 'partial' && lookup?.kind === 'exists') {
      return EXISTS_ONLY_DOC;
    }
    recordMissing(normalized, lookup);
    return null;
  };

  const simulated = effectiveSimulate(
    [buildFirestoreTestCase(call, effectivePath, method, targetDoc)],
    { getDoc },
  );
  if (!simulated.success) return undefined;
  const result = simulated.data.results[0];
  if (result === undefined || result.decision === 'UNSUPPORTED') return undefined;

  const listUnprovable =
    method === 'list' && !isCollectionGroup && result.queryProof?.provable === false;
  const allowed = !listUnprovable && result.decision === 'ALLOW';
  const entries = decidingTraceEntries(result, allowed);
  const expressions = evaluatedExpressionsOf(entries, parsed);

  let lookupMissing = fallbackMissing;
  for (const entry of entries) {
    if (entry.expressionTrace !== undefined) {
      lookupMissing = unionPaths(lookupMissing, missingByTrace.get(entry.expressionTrace));
    }
  }

  let targetMissing: string[] = [];
  if (method !== 'list') {
    const readsUncapturedResource =
      !given.document && expressions.some((text) => RESOURCE_READ.test(text));
    const readsUncapturedUpdateBase =
      given.writeData && !given.wholeWrite && expressions.some((text) => WRITE_READ.test(text));
    if (readsUncapturedResource || readsUncapturedUpdateBase) {
      targetMissing = [normalizeDocumentPath(path)];
    }
  }

  const missingPaths = unionPaths(lookupMissing, targetMissing);
  const exprGaps = gapsIn(expressions, FIRESTORE_GAPS, given);
  let needs = exprGaps;
  if (lookupMissing.length > 0) {
    needs = unionOf(['stored-document'], exprGaps);
  }
  const hasUncapturedListFilters =
    call.query === undefined || (call.query.filters?.length ?? 0) > 0;
  if (listUnprovable && result.queryProof?.kind !== 'no-rule' && hasUncapturedListFilters) {
    needs = unionOf(['query'], needs);
  }
  const deciding = projectEvaluatedRule(result) ?? result.queryProof?.rule;
  let rule: Evaluation['rule'];
  if (deciding !== undefined) {
    rule = definedOnly({ line: deciding.line, expression: deciding.expression });
  }
  return {
    allowed,
    rule,
    needs,
    missingPaths,
    trace: captureRulesEvidence(result, LOCAL_TRACE_VERSION),
  };
}

function evaluateSetDoc(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  path: string,
  observedSession: ObservedSessionDataStore | undefined,
  parsed: ParsedRulesEntry | null,
): Evaluation | undefined {
  const given = givenBy(call, 'set');
  const targetDoc = resolveTargetDoc(call, path, 'set', observedSession);
  if (targetDoc.status === 'absent') {
    return evaluateFirestore(simulate, call, path, 'create', given, observedSession, parsed);
  }
  if (targetDoc.status === 'complete' || targetDoc.status === 'partial') {
    return evaluateFirestore(simulate, call, path, 'update', given, observedSession, parsed);
  }
  const create = evaluateFirestore(simulate, call, path, 'create', given, observedSession, parsed);
  const update = evaluateFirestore(simulate, call, path, 'update', given, observedSession, parsed);
  if (create === undefined || update === undefined) return undefined;
  const needs = unionOf(create.needs, update.needs);
  const branchMissing = unionPaths(create.missingPaths, update.missingPaths);
  if (create.allowed === update.allowed) {
    return { ...create, needs, missingPaths: branchMissing };
  }
  return {
    allowed: create.allowed,
    rule: undefined,
    needs: unionOf(['stored-document'], needs),
    missingPaths: unionPaths([normalizeDocumentPath(path)], branchMissing),
  };
}

export function evaluateFirestoreCall(
  simulate: FirestoreSimulate,
  call: ObservedCall,
  method: ObservedMethod,
  observedSession?: ObservedSessionDataStore,
  rulesSource?: string,
): Evaluation | undefined {
  const path = call.path;
  if (path === undefined) return undefined;
  const parsed = parsedRulesOf(rulesSource);
  if (method === 'set') return evaluateSetDoc(simulate, call, path, observedSession, parsed);
  return evaluateFirestore(
    simulate,
    call,
    path,
    method,
    givenBy(call, method),
    observedSession,
    parsed,
  );
}

export function firestoreVerdict(
  ctx: HostCtx,
  call: ObservedCall,
  method: ObservedMethod,
): LocalVerdict | undefined {
  const env = getInternalEnv(ctx.sandbox);
  const rulesSource = env.getRules();
  if (!hasAppFirestoreRules(ctx, rulesSource)) return undefined;
  const evaluation = evaluateFirestoreCall(
    (cases, lookups) => env.simulateDeployedRules(cases, lookups),
    call,
    method,
    ctx.observedSession,
    rulesSource,
  );
  if (evaluation === undefined) return undefined;
  return verdictOf(call, evaluation);
}
