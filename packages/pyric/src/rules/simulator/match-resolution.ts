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
 */
export function collectMatches(
  block: MatchBlock,
  pathSegments: string[],
  parentFunctions: FunctionDef[],
  recorder?: { push(entry: PathResolutionEntry): void },
): MatchResult[] {
  const allFunctions = [...parentFunctions, ...block.functions];
  const pattern = block.path.segments;
  const bindings: Record<string, string> = {};
  const candidateVariables: string[] = [];
  let consumed = 0;
  let failureReason: PathResolutionEntry['reason'] | undefined;

  for (const segment of pattern) {
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
      bindings[segment.name] = pathSegments.slice(consumed).join('/');
      if (consumed < pathSegments.length) candidateVariables.push(segment.name);
      consumed = pathSegments.length;
    }
  }

  if (failureReason !== undefined) {
    recorder?.push({
      ...(block.loc ? { line: block.loc.line } : {}),
      blockPath: renderMatchBlockPath(block),
      matchedSegments: consumed,
      totalSegments: pattern.length,
      bindings,
      matched: false,
      reason: failureReason,
    });
    return [];
  }

  const remaining = pathSegments.slice(consumed);
  if (remaining.length === 0) {
    recorder?.push({
      ...(block.loc ? { line: block.loc.line } : {}),
      blockPath: renderMatchBlockPath(block),
      matchedSegments: consumed,
      totalSegments: pattern.length,
      bindings,
      matched: true,
    });
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

  recorder?.push({
    ...(block.loc ? { line: block.loc.line } : {}),
    blockPath: renderMatchBlockPath(block),
    matchedSegments: consumed,
    totalSegments: pattern.length,
    bindings,
    ...(results.length > 0
      ? { matched: true }
      : { matched: false, reason: 'no-matching-child' as const }),
  });
  return results;
}
