/**
 * Production's load check for a Firestore rules source, for a caller that
 * holds the source rather than its AST: the source must parse, its service
 * must be `cloud.firestore`, and it must be within production's compile
 * limits. Every path that loads Firestore rules runs this one check: the
 * CLI's `rules.set`, the in-process server's project rules, a seed's rules,
 * the dev server's rules load, the served worker's rules deploy, the
 * simulator, and `firestoreRules()` each refuse a source it rejects. The SDK
 * sandbox's `setRules` installs such a source, evaluates no request against
 * it, and reports the same reason as its status and its denial reason.
 *
 * Storage loads through `parseStorageRules`, which checks its own service. A
 * Storage caller that wants only the parse and compile-limit half runs
 * {@link rulesGrammarRejection}.
 */
import type { FirestoreRules, ServiceBlock } from './FirestoreAST.js';
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
  | {
      kind: 'parse';
      line: number;
      column: number;
      message: string;
      /** The service the source names, when the rejection is that it is not `cloud.firestore`. */
      otherService?: string;
    }
  | { kind: 'compile'; violations: CompileLimitViolation[]; message: string };

/** Why production would not load `source` as Firestore rules, or null when it would. */
export function rulesSourceRejection(source: string): RulesSourceRejection | null {
  const checked = checkRulesSource(source);
  return checked.ok ? null : checked.rejection;
}

/**
 * Why `source` does not parse or is past a compile limit, whatever its
 * service, or null when neither holds. For a Storage caller, whose own load
 * check (`parseStorageRules`) refuses a service other than its own.
 */
export function rulesGrammarRejection(source: string): RulesSourceRejection | null {
  const checked = checkRulesGrammar(source);
  return checked.ok ? null : checked.rejection;
}

/** The parsed ruleset production would load as Firestore rules, or why it would not load `source`. */
export function checkRulesSource(
  source: string,
): { ok: true; ast: FirestoreRules } | { ok: false; rejection: RulesSourceRejection } {
  const checked = checkRulesGrammar(source);
  if (!checked.ok) return checked;
  const service = checked.ast.service;
  if (isOtherService(service)) return { ok: false, rejection: wrongServiceRejection(service) };
  return checked;
}

const FIRESTORE_SERVICE = 'cloud.firestore';

function isOtherService(service: ServiceBlock | undefined): service is ServiceBlock {
  return service !== undefined && service.name !== FIRESTORE_SERVICE;
}

/**
 * A ruleset for another service, reported at its `service` keyword. Kind
 * `'parse'`, as `firestoreRules()` reports it (`PARSE_ERROR`), so every
 * caller that switches on the kind refuses it as it refuses a parse failure.
 */
function wrongServiceRejection(service: ServiceBlock): RulesSourceRejection {
  return {
    kind: 'parse',
    line: service.loc?.line ?? 1,
    column: service.loc?.col ?? 1,
    message: `rules did not compile: ${wrongServiceReason(service.name)}`,
    otherService: service.name,
  };
}

/** Production's reason for a ruleset whose service is `name`, not Firestore's. */
export function wrongServiceReason(name: string): string {
  return `Expected 'service ${FIRESTORE_SERVICE}', got 'service ${name}'.`;
}

/** The parsed ruleset, or why it does not parse or breaks a compile limit, whatever its service. */
function checkRulesGrammar(
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
