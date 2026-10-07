import type { MatchBlock, FunctionDef } from '../grammar/FirestoreAST.js';
import type { PathResolutionEntry } from '../test/spec.js';

export interface MatchResult {
  block: MatchBlock;
  pathVariables: Record<string, string>;
  /** Wildcards whose value includes the final candidate-document segment. */
  candidateVariables: string[];
  /** Global, service, root, ancestor, and matched-block helpers in scope. */
  functions: FunctionDef[];
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
 * A recursive wildcard matches zero or more segments. Its placement in the
 * block's own path decides how far it reaches:
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
  recorder?: Recorder,
): MatchResult[] {
  const allFunctions = [...parentFunctions, ...block.functions];
  const pattern = block.path.segments;
  const bindings: Record<string, string> = {};
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
      if (consumed === pathSegments.length - 1) candidateVariables.push(segment.name);
      consumed++;
    } else {
      const trailing = pattern.length - index - 1;
      const length = pathSegments.length - consumed - trailing;
      if (length < 0) {
        failureReason = 'request-shorter';
        break;
      }
      bindings[segment.name] = pathSegments.slice(consumed, consumed + length).join('/');
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

  if (finalRecursive) {
    const results = [
      { block, pathVariables: bindings, candidateVariables, functions: allFunctions },
      ...collectBelowRecursive(block, pathSegments, allFunctions, bindings, finalRecursive, recorder),
    ];
    recorder?.push(entry({ matched: true }));
    return results;
  }

  const remaining = pathSegments.slice(consumed);
  if (remaining.length === 0) {
    recorder?.push(entry({ matched: true }));
    return [{ block, pathVariables: bindings, candidateVariables, functions: allFunctions }];
  }

  const results: MatchResult[] = [];
  for (const child of block.children) {
    for (const childResult of collectMatches(child, remaining, allFunctions, recorder)) {
      childResult.pathVariables = { ...bindings, ...childResult.pathVariables };
      childResult.candidateVariables = [...candidateVariables, ...childResult.candidateVariables];
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
  recursive: { name: string; start: number },
  recorder: Recorder | undefined,
): MatchResult[] {
  if (block.children.length === 0) return [];
  const results: MatchResult[] = [];
  const resolved = new Set<MatchBlock>();
  let firstAttempts: PathResolutionEntry[] | undefined;
  for (let end = pathSegments.length - 1; end >= recursive.start; end--) {
    const remaining = pathSegments.slice(end);
    const prefix = { ...bindings, [recursive.name]: pathSegments.slice(recursive.start, end).join('/') };
    const attempts: PathResolutionEntry[] = [];
    let produced = false;
    for (const child of block.children) {
      for (const childResult of collectMatches(child, remaining, functions, { push: (e) => attempts.push(e) })) {
        if (resolved.has(childResult.block)) continue;
        resolved.add(childResult.block);
        produced = true;
        childResult.pathVariables = { ...prefix, ...childResult.pathVariables };
        results.push(childResult);
      }
    }
    firstAttempts ??= attempts;
    if (produced) for (const attempt of attempts) recorder?.push(attempt);
  }
  if (results.length === 0) for (const attempt of firstAttempts ?? []) recorder?.push(attempt);
  return results;
}
