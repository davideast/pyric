/**
 * Production's compile rejections for a Firestore or Storage rules source,
 * for a caller that holds the source rather than its AST: the CLI's
 * `rules.set`, the dev server's rules load, and the served worker's rules
 * deploy refuse a source these reject, as `firestoreRules()` and
 * `parseStorageRules()` do.
 */
import { parseToAST } from './FirestoreParser.js';
import { compileLimitViolations, type CompileLimitViolation } from './compile-limits.js';

/** Every compile rejection for `source`, in source order; empty when it does not parse or is within every limit. */
export function sourceCompileLimitViolations(source: string): CompileLimitViolation[] {
  const ast = parseToAST(source);
  return ast === null ? [] : compileLimitViolations(ast);
}
