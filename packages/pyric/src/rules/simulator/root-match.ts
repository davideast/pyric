import type { FirestoreRules, FunctionDef, MatchBlock, PathSegment } from '../grammar/FirestoreAST.js';
import type { PathResolutionEntry } from '../test/spec.js';
import { recursiveWildcardMinimum } from '../grammar/recursive-wildcard-minimum.js';
import { topLevelMatches } from '../grammar/service-blocks.js';
import { collectMatches, renderMatchBlockPath, type MatchResult } from './match-resolution.js';
import { DOCUMENT_PATH_FORM } from './request-path.js';

/**
 * The service's root `match` is a path like any other. Production compares
 * it with the full resource name of the request,
 * `/databases/(default)/documents/<document path>`, so a root that names
 * another database, another subtree, or a misspelled `documents` grants
 * nothing (capture `rules-firestore-service-root-match-path`). The sandbox
 * models one database, `(default)`, so every request carries that name.
 */
const REQUEST_PREFIX = ['databases', '(default)', 'documents'] as const;

/** The full resource name of a document-relative request path. */
export function requestResourceName(documentPath: string): string {
  return `/${[...REQUEST_PREFIX, ...splitPath(documentPath)].join('/')}`;
}

export interface RootMatch {
  /** The root's wildcard bindings, such as `database: '(default)'`. */
  bindings: Record<string, string>;
  /** Recursive wildcard names (`{name=**}`) bound in `bindings`. */
  recursiveVariables?: string[];
  /** The request segments the root's children match. */
  remaining: string[];
  /** Set when the root ends in a recursive wildcard. Its children then
   *  resolve at any depth below the segments the root's other parts consumed,
   *  as nested blocks under a final recursive wildcard do anywhere else. */
  recursiveTail?: { name: string };
}

/**
 * Resolve the root match against one document-relative request path. A
 * literal must equal its segment, a single wildcard binds its segment, and a
 * recursive wildcard binds the rest: in the last position it leaves its
 * children to resolve below it, and anywhere else it binds the fewest
 * segments that let the segments after it match, and at least one under
 * version 1. Returns null when the root does not
 * apply to the request.
 */
export function resolveRootBlockMatch(
  rootBlock: MatchBlock,
  rulesVersion: string,
  documentPath: string,
): RootMatch | null {
  const request = [...REQUEST_PREFIX, ...splitPath(documentPath)];
  return resolveRootSegments(rootBlock.path.segments, request, recursiveWildcardMinimum(rulesVersion));
}

export function resolveRootMatch(ast: FirestoreRules, documentPath: string): RootMatch | null {
  for (const rootBlock of topLevelMatches(ast.service)) {
    const matched = resolveRootBlockMatch(rootBlock, ast.version, documentPath);
    if (matched !== null) return matched;
  }
  return null;
}

function resolveRootSegments(
  pattern: readonly PathSegment[],
  request: readonly string[],
  minimum: number,
): RootMatch | null {
  const bindings: Record<string, string> = {};
  let consumed = 0;
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]!;
    if (segment.type === 'recursive') {
      const isLast = index === pattern.length - 1;
      if (isLast) {
        return { bindings, remaining: request.slice(consumed), recursiveTail: { name: segment.name } };
      }
      return resolveInnerRecursive(segment.name, pattern.slice(index + 1), request, consumed, bindings, minimum);
    }
    const hasSegment = consumed < request.length;
    if (!hasSegment) return null;
    const value = request[consumed]!;
    if (segment.type === 'literal' && segment.value !== value) return null;
    if (segment.type === 'wildcard') bindings[segment.name] = value;
    consumed++;
  }
  return { bindings, remaining: request.slice(consumed) };
}

/** A recursive wildcard inside the root, followed by more segments, takes the
 *  shortest span after which the rest of the root matches. Whether the
 *  children then resolve does not change the span. No deployed root has this
 *  shape, and no capture records production's choice. */
function resolveInnerRecursive(
  name: string,
  rest: readonly PathSegment[],
  request: readonly string[],
  start: number,
  bindings: Record<string, string>,
  minimum: number,
): RootMatch | null {
  for (let end = start + minimum; end <= request.length; end++) {
    const tail = resolveRootSegments(rest, request.slice(end), minimum);
    if (tail) {
      const tailRec = tail.recursiveVariables ?? [];
      return {
        ...tail,
        bindings: { ...bindings, [name]: request.slice(start, end).join('/'), ...tail.bindings },
        recursiveVariables: [name, ...tailRec],
      };
    }
  }
  return null;
}

function collectRootRecursiveNames(root: RootMatch): string[] {
  const names: string[] = [];
  if (root.recursiveVariables !== undefined) {
    names.push(...root.recursiveVariables);
  }
  if (root.recursiveTail !== undefined) {
    names.push(root.recursiveTail.name);
  }
  return names;
}

/**
 * Every block that resolves the request, each with the root's bindings folded
 * into its own: the root block itself when its path matches the request's
 * full resource name, then the blocks under it. Returns an empty list when
 * the root does not apply, so the request is denied as production denies it.
 */
function mergeRootFunctions(
  enclosing: readonly FunctionDef[],
  rootFunctions: readonly FunctionDef[],
): FunctionDef[] {
  const merged = [...enclosing];
  for (const fn of rootFunctions) {
    if (!merged.includes(fn)) {
      merged.push(fn);
    }
  }
  return merged;
}

export function collectRootMatches(
  ast: FirestoreRules,
  documentPath: string,
  functions: FunctionDef[],
  recorder?: { push(entry: PathResolutionEntry): void },
): MatchResult[] {
  const allMatches: MatchResult[] = [];
  for (const rootBlock of topLevelMatches(ast.service)) {
    const root = resolveRootBlockMatch(rootBlock, ast.version, documentPath);
    if (!root) continue;
    const blockFunctions = mergeRootFunctions(functions, rootBlock.functions);
    const tail = root.recursiveTail;
    let children: MatchResult[];
    if (tail) {
      children = collectBelowRootRecursive(rootBlock, tail.name, root.remaining, blockFunctions, ast.version, recorder);
    } else {
      children = rootBlock.children.flatMap((child) =>
        collectMatches(child, root.remaining, blockFunctions, ast.version, recorder),
      );
    }
    const rootRecVars = collectRootRecursiveNames(root);
    for (const result of children) {
      result.pathVariables = { ...root.bindings, ...result.pathVariables };
      if (rootRecVars.length > 0) {
        const childRec = result.recursiveVariables ?? [];
        result.recursiveVariables = [...rootRecVars, ...childRec];
      }
    }
    const own = rootBlockMatch(rootBlock, ast.version, root, blockFunctions);
    if (own) {
      allMatches.push(own);
    }
    allMatches.push(...children);
  }
  return allMatches;
}

/**
 * The root block as a match of its own, when its path matches the request's
 * full resource name. Production then evaluates the `allow` statements
 * written on it, as on any other block: under `match /{path=**}`, an
 * `allow read` on the root grants get `c/1` and list `c`, and `path` binds
 * `databases/(default)/documents/c/1` (captures
 * `c4a-root-recursive-with-own-allow`, `c4c-root-recursive-path-value`,
 * `c5e-root-recursive-own-allow-write`). A root that stops short of the
 * document, such as `/databases/{database}/documents`, matches only through
 * its children, and its own rules grant nothing (capture
 * `c4b-root-documents-own-allow`).
 */
function rootBlockMatch(
  block: MatchBlock,
  rulesVersion: string,
  root: RootMatch,
  functions: FunctionDef[],
): MatchResult | null {
  const tail = root.recursiveTail;
  let reachesTheDocument = root.remaining.length === 0;
  if (tail) {
    reachesTheDocument = root.remaining.length >= recursiveWildcardMinimum(rulesVersion);
  }
  if (!reachesTheDocument) return null;
  let pathVariables: Record<string, string> = root.bindings;
  if (tail) {
    pathVariables = { ...root.bindings, [tail.name]: root.remaining.join('/') };
  }
  const recursiveVariables = collectRootRecursiveNames(root);
  const result: MatchResult = {
    block,
    pathVariables,
    candidateVariables: rootCandidateVariables(block, root),
    functions,
  };
  if (recursiveVariables.length > 0) {
    result.recursiveVariables = recursiveVariables;
  }
  return result;
}

/** The root wildcard that binds the request's last segment, the candidate
 *  document of a list query. */
function rootCandidateVariables(block: MatchBlock, root: RootMatch): string[] {
  const tail = root.recursiveTail;
  if (tail) return root.remaining.length > 0 ? [tail.name] : [];
  const last = block.path.segments.at(-1);
  return last?.type === 'wildcard' ? [last.name] : [];
}

/** Children of a root that ends in a recursive wildcard resolve through a
 *  stand-in block with that wildcard alone and no rules of its own, so they
 *  follow the same depth search as any block under a final recursive one.
 *  The stand-in is not a block the author wrote, so its own resolution
 *  attempt is left out of the trace. The root block's own allow rules are
 *  evaluated through `rootBlockMatch`, not through the stand-in. */
function collectBelowRootRecursive(
  rootBlock: MatchBlock,
  name: string,
  remaining: string[],
  functions: FunctionDef[],
  rulesVersion: string,
  recorder?: { push(entry: PathResolutionEntry): void },
): MatchResult[] {
  const standInPath = `/{${name}=**}`;
  const standIn: MatchBlock = {
    path: { raw: standInPath, segments: [{ type: 'recursive', name }] },
    functions: [],
    allows: [],
    children: rootBlock.children,
  };
  const authoredOnly = recorder && {
    push(entry: PathResolutionEntry) {
      const isStandIn = entry.blockPath === standInPath && entry.line === undefined;
      if (!isStandIn) recorder.push(entry);
    },
  };
  return collectMatches(standIn, remaining, functions, rulesVersion, authoredOnly).filter((result) => result.block !== standIn);
}

/**
 * Whether the root governs every document of the database, which a
 * collection-group query needs: its path is the database's documents path
 * with nothing after it, or it reaches every document through a recursive
 * wildcard. A root with literals after `documents` governs only the documents
 * under them, and a group query spans every collection with its id. Under
 * version 1 a recursive wildcard needs a segment, so one right after
 * `documents` misses the top-level documents and does not govern them all.
 */
export function rootBlockGovernsEveryDocument(rootBlock: MatchBlock, rulesVersion: string): boolean {
  const root = resolveRootBlockMatch(rootBlock, rulesVersion, '');
  if (!root) return false;
  const endsAtDocuments = root.recursiveTail === undefined && root.remaining.length === 0;
  // `remaining` is what the empty document path leaves the tail: under
  // `/databases/{db}/{rest=**}` it is `documents`, under
  // `/databases/{db}/documents/{rest=**}` nothing.
  const tailHasItsSegments = root.remaining.length >= recursiveWildcardMinimum(rulesVersion);
  const tailReachesEveryDocument = root.recursiveTail !== undefined && tailHasItsSegments;
  return endsAtDocuments || tailReachesEveryDocument;
}

export function rootGovernsEveryDocument(ast: FirestoreRules): boolean {
  return topLevelMatches(ast.service).some((rootBlock) =>
    rootBlockGovernsEveryDocument(rootBlock, ast.version),
  );
}

/** The notes for a request no match block resolves: the root names the
 *  request it does not apply to, and otherwise no block under it matched. */
export function noMatchNotes(ast: FirestoreRules, documentPath: string): string[] {
  const rootApplies = resolveRootMatch(ast, documentPath) !== null;
  if (rootApplies) {
    return [`No match block found for path '${documentPath}', so the request is denied by default.`, DOCUMENT_PATH_FORM];
  }
  const roots = topLevelMatches(ast.service);
  if (roots.length <= 1) {
    const rootPath = renderMatchBlockPath(ast.service.match);
    return [`The root match '${rootPath}' does not match '${requestResourceName(documentPath)}', so no match block applies and the request is denied.`];
  }
  const rootPaths = roots.map((r) => `'${renderMatchBlockPath(r)}'`).join(', ');
  return [`None of the root matches (${rootPaths}) match '${requestResourceName(documentPath)}', so no match block applies and the request is denied.`];
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
