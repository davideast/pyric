import type { FirestoreRules, FunctionDef, MatchBlock, PathSegment } from '../grammar/FirestoreAST.js';
import type { PathResolutionEntry } from '../test/spec.js';
import { collectMatches, renderMatchBlockPath, type MatchResult } from './match-resolution.js';

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
 * children to resolve below it, and anywhere else it binds the fewest segments
 * that let the segments after it match. Returns null when the root does not
 * apply to the request.
 */
export function resolveRootMatch(ast: FirestoreRules, documentPath: string): RootMatch | null {
  return resolveRootSegments(ast.service.match.path.segments, [...REQUEST_PREFIX, ...splitPath(documentPath)]);
}

function resolveRootSegments(pattern: readonly PathSegment[], request: readonly string[]): RootMatch | null {
  const bindings: Record<string, string> = {};
  let consumed = 0;
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]!;
    if (segment.type === 'recursive') {
      const isLast = index === pattern.length - 1;
      if (isLast) {
        return { bindings, remaining: request.slice(consumed), recursiveTail: { name: segment.name } };
      }
      return resolveInnerRecursive(segment.name, pattern.slice(index + 1), request, consumed, bindings);
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

function resolveInnerRecursive(
  name: string,
  rest: readonly PathSegment[],
  request: readonly string[],
  start: number,
  bindings: Record<string, string>,
): RootMatch | null {
  for (let end = start; end <= request.length; end++) {
    const tail = resolveRootSegments(rest, request.slice(end));
    if (tail) {
      return {
        ...tail,
        bindings: { ...bindings, [name]: request.slice(start, end).join('/'), ...tail.bindings },
      };
    }
  }
  return null;
}

/**
 * Every block under the root that resolves the request, each with the root's
 * bindings folded into its own. Returns an empty list when the root does not
 * apply, so the request is denied as production denies it.
 */
export function collectRootMatches(
  ast: FirestoreRules,
  documentPath: string,
  functions: FunctionDef[],
  recorder?: { push(entry: PathResolutionEntry): void },
): MatchResult[] {
  const root = resolveRootMatch(ast, documentPath);
  if (!root) return [];
  const results = root.recursiveTail
    ? collectBelowRootRecursive(ast.service.match, root, functions, recorder)
    : ast.service.match.children.flatMap((child) => collectMatches(child, root.remaining, functions, recorder));
  for (const result of results) {
    result.pathVariables = { ...root.bindings, ...result.pathVariables };
  }
  return results;
}

/** Children of a root that ends in a recursive wildcard resolve through a
 *  stand-in block with that wildcard alone and no rules of its own, so they
 *  follow the same depth search as any block under a final recursive one. */
function collectBelowRootRecursive(
  rootBlock: MatchBlock,
  root: RootMatch,
  functions: FunctionDef[],
  recorder?: { push(entry: PathResolutionEntry): void },
): MatchResult[] {
  const standIn: MatchBlock = {
    path: { raw: `/{${root.recursiveTail!.name}=**}`, segments: [{ type: 'recursive', name: root.recursiveTail!.name }] },
    functions: [],
    allows: [],
    children: rootBlock.children,
  };
  return collectMatches(standIn, root.remaining, functions, recorder).filter((result) => result.block !== standIn);
}

/**
 * Whether the root governs every document of the database, which a
 * collection-group query needs: its path is the database's documents path
 * with nothing after it, or it reaches every document through a recursive
 * wildcard. A root with literals after `documents` governs only the documents
 * under them, and a group query spans every collection with its id.
 */
export function rootGovernsEveryDocument(ast: FirestoreRules): boolean {
  const root = resolveRootMatch(ast, '');
  if (!root) return false;
  const coversEverything = root.remaining.length === 0;
  return coversEverything || root.recursiveTail !== undefined;
}

/** The note for a request the root match does not apply to. */
export function rootMismatchNote(ast: FirestoreRules, documentPath: string): string {
  const rootPath = renderMatchBlockPath(ast.service.match);
  return `The root match '${rootPath}' does not match '${requestResourceName(documentPath)}', so no match block applies and the request is denied.`;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
