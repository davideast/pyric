/**
 * Production's load check for a Firestore or Storage rules source, for a
 * caller that holds the source rather than its AST: the source must parse,
 * and it must be within production's compile limits. Every path that loads
 * rules runs this one check: the CLI's `rules.set`, the in-process server's
 * project rules, a seed's rules, the dev server's rules load, and the served
 * worker's rules deploy each refuse a source it rejects, as `firestoreRules()`
 * and `parseStorageRules()` do; the SDK sandbox's `setRules` installs such a
 * source and reports the same reason as its status and its denial reason.
 */
import type { FirestoreRules } from './FirestoreAST.js';
import { parseToASTOrError } from './FirestoreParser.js';
import {
  compileLimitViolations,
  describeCompileLimitViolations,
  type CompileLimitViolation,
} from './compile-limits.js';
import { parseErrorWording } from './parse-error-wording.js';

/** Every compile rejection for `source`, in source order; empty when it does not parse or is within every limit. */
export function sourceCompileLimitViolations(source: string): CompileLimitViolation[] {
  const parsed = parseToASTOrError(source);
  return parsed.ok ? compileLimitViolations(parsed.ast) : [];
}

/**
 * Why production would not load a rules source. `message` is the reason as
 * a clause a caller prefixes with the service ("Firestore rules did not
 * parse at line 4, column 44: expected ';' ..."): the parser's failure with
 * its position, or production's own compile messages.
 */
export type RulesSourceRejection =
  | { kind: 'parse'; line: number; column: number; message: string }
  | { kind: 'compile'; violations: CompileLimitViolation[]; message: string };

/** Why production would not load `source`, or null when it would. */
export function rulesSourceRejection(source: string): RulesSourceRejection | null {
  const checked = checkRulesSource(source);
  return checked.ok ? null : checked.rejection;
}

/** The parsed ruleset production would load, or why it would not load `source`. */
export function checkRulesSource(
  source: string,
): { ok: true; ast: FirestoreRules } | { ok: false; rejection: RulesSourceRejection } {
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    const { line, column } = parsed.error;
    return {
      ok: false,
      rejection: {
        kind: 'parse',
        line,
        column,
        message: `rules did not parse at line ${line}, column ${column}: ${parseErrorWording(parsed.error, source)}.`,
      },
    };
  }
  const violations = compileLimitViolations(parsed.ast);
  if (violations.length === 0) return { ok: true, ast: parsed.ast };
  return {
    ok: false,
    rejection: { kind: 'compile', violations, message: `rules did not compile: ${describeCompileLimitViolations(violations)}` },
  };
}
