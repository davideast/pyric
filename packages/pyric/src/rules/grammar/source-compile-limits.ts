/**
 * Production's load check for a Firestore rules source, for a caller that
 * holds the source rather than its AST: the source must be smaller than
 * 262,144 bytes, it must parse, its service must be `cloud.firestore`, it
 * must not declare one service twice, and it must be within production's
 * compile limits. Every path that loads
 * Firestore rules runs this one check: the CLI's `rules.set`, the
 * in-process server's project rules, a seed's rules, the dev server's rules
 * load, the served worker's rules deploy, the simulator, and
 * `firestoreRules()` each refuse a source it rejects. The SDK
 * sandbox's `setRules` installs such a source, evaluates no request against
 * it, and reports the same reason as its status and its denial reason.
 *
 * Storage loads through `parseStorageRules`, which checks its own service. A
 * Storage caller that wants only the parse and compile-limit half runs
 * {@link rulesGrammarRejection}, which does not check the source size: no
 * capture measured Storage's.
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
  const tooLarge = sourceSizeRejection(source);
  if (tooLarge !== null) return { ok: false, rejection: tooLarge };
  const checked = checkRulesGrammar(source);
  if (!checked.ok) return checked;
  const service = checked.ast.service;
  if (isOtherService(service)) return { ok: false, rejection: wrongServiceRejection(service) };
  const duplicate = duplicateServiceRejection(checked.ast);
  if (duplicate !== null) return { ok: false, rejection: duplicate };
  return checked;
}

const FIRESTORE_SERVICE = 'cloud.firestore';

/**
 * The fewest UTF-8 bytes of source production refuses as Firestore rules.
 * Inferred from production's message ("smaller than 262144"): the captures
 * sent 300,145 and 200,145 bytes, and no capture measured the boundary.
 */
const SOURCE_SIZE_LIMIT_BYTES = 262_144;

/** Production's reason for a source of `SOURCE_SIZE_LIMIT_BYTES` or more (capture c5j-source-300k-comment). */
const SOURCE_SIZE_REASON = `Total size of sources must be smaller than ${SOURCE_SIZE_LIMIT_BYTES}.`;

/** The most UTF-8 bytes one UTF-16 code unit encodes to. */
const MAX_BYTES_PER_CODE_UNIT = 3;

/** How many bytes `source` encodes to in UTF-8. */
function utf8ByteLength(source: string): number {
  return new TextEncoder().encode(source).length;
}

function isPastSourceSizeLimit(source: string): boolean {
  if (source.length >= SOURCE_SIZE_LIMIT_BYTES) return true;
  const fitsWhateverItsCharacters = source.length * MAX_BYTES_PER_CODE_UNIT < SOURCE_SIZE_LIMIT_BYTES;
  if (fitsWhateverItsCharacters) return false;
  return utf8ByteLength(source) >= SOURCE_SIZE_LIMIT_BYTES;
}

/**
 * Why production refuses a Firestore source of 262,144 bytes or more, or
 * null when it is smaller. The loader and the linter both call it, so they
 * share one limit and one count. Production refused a 300,145-byte source with
 * 400 INVALID_ARGUMENT, "Total size of sources must be smaller than
 * 262144.", and compiled a 200,145-byte one (captures
 * c5j-source-300k-comment and c5k-source-200k-comment in
 * `test/rules/grammar/fixtures/size-limits/captures.json`). Both sources
 * were ASCII, where bytes and characters agree; pyric counts UTF-8 bytes,
 * and no capture measured a source past ASCII. Production returned the
 * refusal as a request error rather than a compile issue, so the check runs
 * before the parse and reports no line.
 */
export function sourceSizeViolation(source: string): CompileLimitViolation | null {
  if (!isPastSourceSizeLimit(source)) return null;
  return { code: 'SOURCE_SIZE', message: SOURCE_SIZE_REASON };
}

/** {@link sourceSizeViolation} as the rejection `checkRulesSource` returns. */
function sourceSizeRejection(source: string): Extract<RulesSourceRejection, { kind: 'compile' }> | null {
  const violation = sourceSizeViolation(source);
  if (violation === null) return null;
  const violations = [violation];
  return { kind: 'compile', violations, message: `rules did not compile: ${describeCompileLimitViolations(violations)}` };
}

/** Production's reason for a file with two blocks for one service. */
export const DUPLICATE_SERVICE_REASON = 'Duplicate service name declaration.';

/** The first block that names a service an earlier block in the file already names. */
function duplicateService(services: readonly ServiceBlock[]): ServiceBlock | undefined {
  const seen = new Set<string>();
  for (const block of services) {
    if (seen.has(block.name)) return block;
    seen.add(block.name);
  }
  return undefined;
}

/**
 * Why production refuses a parsed file with two blocks for one service,
 * reported at the second block's `service` keyword (capture
 * c5b-two-firestore-services), or null when every block names its own
 * service. Kind `'parse'`, as the wrong-service rejection, so every caller
 * refuses it as it refuses a parse failure. The module resolver runs it
 * too, since it rebuilds the source from one block.
 */
export function duplicateServiceRejection(ast: FirestoreRules): Extract<RulesSourceRejection, { kind: 'parse' }> | null {
  const block = duplicateService(ast.services ?? []);
  if (block === undefined) return null;
  return {
    kind: 'parse',
    line: block.loc?.line ?? 1,
    column: block.loc?.col ?? 1,
    message: `rules did not compile: ${DUPLICATE_SERVICE_REASON}`,
  };
}

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
