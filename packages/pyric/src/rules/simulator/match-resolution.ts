import type { FirestoreRules, MatchBlock, FunctionDef } from '../grammar/FirestoreAST.js';
import { collectRulesetScopes, functionReferences, type NameScope } from '../grammar/function-scopes.js';
import { recursiveWildcardMinimum } from '../grammar/recursive-wildcard-minimum.js';
import type { PathResolutionEntry } from '../test/spec.js';

const indexedRulesets = new WeakSet<FirestoreRules>();
const functionScopes = new WeakMap<FunctionDef, NameScope>();

/**
 * Index lexical declaration scopes (functions and path captures) for every
 * function in `ast`, using `grammar/function-scopes.ts` as the single source
 * of truth.
 */
export function indexRulesetScopes(ast: FirestoreRules): void {
  if (indexedRulesets.has(ast)) return;
  indexedRulesets.add(ast);
  const scopes = collectRulesetScopes(ast);
  for (const sf of scopes.functions) {
    functionScopes.set(sf.fn, sf);
  }
}

export function getFunctionScope(fn: FunctionDef): NameScope | undefined {
  return functionScopes.get(fn);
}

/**
 * Return the lexical function map visible at `fn`'s declaration site when `fn`
 * has no lexically undefined calls or unbound variables, or `null` when `fn`
 * references out-of-scope functions or path captures. Falls back to
 * `fallbackFunctions` when `fn`'s ruleset was not indexed via `indexRulesetScopes`.
 */
export function getValidFunctionLexicalScope(
  fn: FunctionDef,
  fallbackFunctions: ReadonlyMap<string, FunctionDef>,
): ReadonlyMap<string, FunctionDef> | null {
  const scope = functionScopes.get(fn);
  if (!scope) return fallbackFunctions;
  const refs = functionReferences({ ...scope, fn });
  if (refs.undefinedCalls.length > 0 || refs.unboundVariables.length > 0) {
    return null;
  }
  return scope.functions;
}

export interface FunctionScopeBindings {
  pathVariables: Record<string, string>;
  recursiveVariables: string[];
  candidateVariables: string[];
}

export interface MatchResult {
  block: MatchBlock;
  pathVariables: Record<string, string>;
  /** Recursive wildcard names (`{name=**}`) bound in `pathVariables`, exposed as `Path` values in rules expressions. */
  recursiveVariables?: string[];
  /** Wildcards whose value includes the final candidate-document segment. */
  candidateVariables: string[];
  /** Global, service, root, ancestor, and matched-block helpers in scope. */
  functions: FunctionDef[];
  /** Per-function lexical wildcard bindings captured at each helper's declaring match block. */
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>;
}

/**
 * Combine an enclosing match block's wildcard bindings with a nested block's
 * bindings. Any wildcard rebound by the child overrides the parent's value as
 * well as its recursive (`{id=**}` vs `{id}`) and candidate-document status.
 */
export function mergeScopeBindings(
  parent: FunctionScopeBindings,
  child: FunctionScopeBindings,
): FunctionScopeBindings {
  const childKeys = new Set(Object.keys(child.pathVariables));
  const childRec = new Set(child.recursiveVariables);
  const childCand = new Set(child.candidateVariables);
  return {
    pathVariables: { ...parent.pathVariables, ...child.pathVariables },
    recursiveVariables: [
      ...parent.recursiveVariables.filter((k) => !childKeys.has(k) || childRec.has(k)),
      ...child.recursiveVariables.filter((k) => !parent.recursiveVariables.includes(k)),
    ],
    candidateVariables: [
      ...parent.candidateVariables.filter((k) => !childKeys.has(k) || childCand.has(k)),
      ...child.candidateVariables.filter((k) => !parent.candidateVariables.includes(k)),
    ],
  };
}

export function prependMatchScope(
  parentBlockFunctions: readonly FunctionDef[],
  parentScope: FunctionScopeBindings,
  childResult: MatchResult,
): void {
  const merged = mergeScopeBindings(parentScope, {
    pathVariables: childResult.pathVariables,
    recursiveVariables: childResult.recursiveVariables ?? [],
    candidateVariables: childResult.candidateVariables,
  });
  childResult.pathVariables = merged.pathVariables;
  childResult.recursiveVariables = merged.recursiveVariables;
  childResult.candidateVariables = merged.candidateVariables;

  const nextFnScopes = new Map<FunctionDef, FunctionScopeBindings>();
  for (const fn of parentBlockFunctions) {
    nextFnScopes.set(fn, parentScope);
  }
  for (const [fn, scope] of childResult.functionScopes ?? []) {
    nextFnScopes.set(fn, mergeScopeBindings(parentScope, scope));
  }
  childResult.functionScopes = nextFnScopes;
}

function ownFunctionScopes(
  blockFunctions: readonly FunctionDef[],
  scope: FunctionScopeBindings,
): Map<FunctionDef, FunctionScopeBindings> {
  const map = new Map<FunctionDef, FunctionScopeBindings>();
  for (const fn of blockFunctions) {
    map.set(fn, scope);
  }
  return map;
}

type Recorder = { push(entry: PathResolutionEntry): void };

/** Render a match path in the source form used by diagnostics. */
export function renderMatchBlockPath(block: MatchBlock): string {
  const parts = block.path.segments.map((segment) => {
    if (segment.type === 'literal') return segment.value;
    if (segment.type === 'wildcard') return `{${segment.name}}`;
    return `{${segment.name}=**}`;
  });
  return `/${parts.join('/')}`;
}

/**
 * Resolve every match block that applies to a document path. Firestore
 * OR-combines allows across overlapping blocks, so resolution cannot stop at
 * the first match. Each result retains its own wildcard bindings and lexical
 * helper scope. An optional recorder receives matched and rejected attempts
 * for simulator diagnostics.
 *
 * A recursive wildcard matches zero or more segments under version 2, and
 * one or more under version 1 (`recursiveWildcardMinimum`). Its placement in
 * the block's own path decides how far it reaches:
 * - Followed by further segments (`/{path=**}/items/{id}`), it binds every
 *   segment except the ones those trailing segments match, so the block
 *   matches only a path that ends in them. Nested blocks are unreachable.
 * - In the last position (`/{document=**}`), the block matches every
 *   remaining segment, and each nested block also resolves at any depth
 *   below it, with the recursive wildcard bound to the longest prefix that
 *   lets the nested block match.
 */
export function collectMatches(
  block: MatchBlock,
  pathSegments: string[],
  parentFunctions: FunctionDef[],
  rulesVersion: string,
  recorder?: Recorder,
): MatchResult[] {
  const minimum = recursiveWildcardMinimum(rulesVersion);
  const allFunctions = [...parentFunctions, ...block.functions];
  const pattern = block.path.segments;
  const bindings: Record<string, string> = {};
  const recursiveVariables: string[] = [];
  const candidateVariables: string[] = [];
  let consumed = 0;
  let failureReason: PathResolutionEntry['reason'] | undefined;
  let finalRecursive: { name: string; start: number } | undefined;

  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]!;
    if (segment.type === 'literal') {
      if (consumed >= pathSegments.length) {
        failureReason = 'request-shorter';
        break;
      }
      if (pathSegments[consumed] !== segment.value) {
        failureReason = 'literal-mismatch';
        break;
      }
      consumed++;
    } else if (segment.type === 'wildcard') {
      if (consumed >= pathSegments.length) {
        failureReason = 'request-shorter';
        break;
      }
      bindings[segment.name] = pathSegments[consumed]!;
      const prevRecIdx = recursiveVariables.indexOf(segment.name);
      if (prevRecIdx >= 0) recursiveVariables.splice(prevRecIdx, 1);
      const prevCandIdx = candidateVariables.indexOf(segment.name);
      if (prevCandIdx >= 0) candidateVariables.splice(prevCandIdx, 1);
      if (consumed === pathSegments.length - 1) candidateVariables.push(segment.name);
      consumed++;
    } else {
      const trailing = pattern.length - index - 1;
      const length = pathSegments.length - consumed - trailing;
      if (length < minimum) {
        failureReason = 'request-shorter';
        break;
      }
      bindings[segment.name] = pathSegments.slice(consumed, consumed + length).join('/');
      if (!recursiveVariables.includes(segment.name)) recursiveVariables.push(segment.name);
      const prevCandIdx = candidateVariables.indexOf(segment.name);
      if (prevCandIdx >= 0) candidateVariables.splice(prevCandIdx, 1);
      if (trailing === 0) {
        finalRecursive = { name: segment.name, start: consumed };
        if (length > 0) candidateVariables.push(segment.name);
      }
      consumed += length;
    }
  }

  const entry = (extra: Partial<PathResolutionEntry>): PathResolutionEntry => ({
    ...(block.loc ? { line: block.loc.line } : {}),
    blockPath: renderMatchBlockPath(block),
    matchedSegments: consumed,
    totalSegments: pattern.length,
    bindings,
    matched: false,
    ...extra,
  });

  if (failureReason !== undefined) {
    recorder?.push(entry({ reason: failureReason }));
    return [];
  }

  const ownScope: FunctionScopeBindings = {
    pathVariables: bindings,
    recursiveVariables,
    candidateVariables,
  };

  if (finalRecursive) {
    const childMatches = collectBelowRecursive(block, pathSegments, allFunctions, bindings, recursiveVariables, finalRecursive, rulesVersion, recorder);
    const results: MatchResult[] = [
      {
        block,
        pathVariables: bindings,
        recursiveVariables,
        candidateVariables,
        functions: allFunctions,
        functionScopes: ownFunctionScopes(block.functions, ownScope),
      },
      ...childMatches,
    ];
    recorder?.push(entry({ matched: true }));
    return results;
  }

  const remaining = pathSegments.slice(consumed);
  const results: MatchResult[] = [];
  // When the block consumes the whole path, a nested block whose path is a
  // single recursive wildcard still matches under version 2, binding zero
  // segments. Under version 1 its own resolution records the miss.
  const children = remaining.length > 0
    ? block.children
    : block.children.filter((child) => child.path.segments.every((segment) => segment.type === 'recursive'));
  if (remaining.length === 0) {
    results.push({
      block,
      pathVariables: bindings,
      recursiveVariables,
      candidateVariables,
      functions: allFunctions,
      functionScopes: ownFunctionScopes(block.functions, ownScope),
    });
  }
  for (const child of children) {
    for (const childResult of collectMatches(child, remaining, allFunctions, rulesVersion, recorder)) {
      prependMatchScope(block.functions, ownScope, childResult);
      results.push(childResult);
    }
  }

  recorder?.push(entry(results.length > 0 ? { matched: true } : { reason: 'no-matching-child' }));
  return results;
}

/**
 * Nested blocks under a final recursive wildcard. Each resolved block keeps
 * the binding with the longest recursive prefix that matches it. Attempts are
 * recorded for the binding that produced a match, or for the longest one when
 * none did.
 */
function collectBelowRecursive(
  block: MatchBlock,
  pathSegments: string[],
  functions: FunctionDef[],
  bindings: Record<string, string>,
  recursiveVariables: string[],
  recursive: { name: string; start: number },
  rulesVersion: string,
  recorder: Recorder | undefined,
): MatchResult[] {
  if (block.children.length === 0) return [];
  const shortestEnd = recursive.start + recursiveWildcardMinimum(rulesVersion);
  const results: MatchResult[] = [];
  const resolved = new Set<MatchBlock>();
  let firstAttempts: PathResolutionEntry[] | undefined;
  for (let end = pathSegments.length - 1; end >= shortestEnd; end--) {
    const remaining = pathSegments.slice(end);
    const prefix = { ...bindings, [recursive.name]: pathSegments.slice(recursive.start, end).join('/') };
    const prefixScope: FunctionScopeBindings = {
      pathVariables: prefix,
      recursiveVariables,
      candidateVariables: [],
    };
    const attempts: PathResolutionEntry[] = [];
    let produced = false;
    for (const child of block.children) {
      for (const childResult of collectMatches(child, remaining, functions, rulesVersion, { push: (e) => attempts.push(e) })) {
        if (resolved.has(childResult.block)) continue;
        resolved.add(childResult.block);
        produced = true;
        prependMatchScope(block.functions, prefixScope, childResult);
        results.push(childResult);
      }
    }
    firstAttempts ??= attempts;
    if (produced) for (const attempt of attempts) recorder?.push(attempt);
  }
  if (results.length === 0) for (const attempt of firstAttempts ?? []) recorder?.push(attempt);
  return results;
}
