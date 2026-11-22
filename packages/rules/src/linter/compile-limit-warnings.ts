import type { FirestoreRules, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  LET_LIMIT,
  NESTING_LEVEL_LIMIT,
  NESTING_MESSAGE,
  SLASH_STARTS_PATH_MESSAGE,
  type CompileLimitViolation,
} from '../grammar/compile-limits.js';
import { sourceSizeViolation } from '../grammar/source-compile-limits.js';
import type { LintWarning } from './linter.js';

export function buildWarningLocation(opts: {
  functionName?: string;
  matchPath?: string;
  line?: number;
}): LintWarning['location'] | undefined {
  const loc: NonNullable<LintWarning['location']> = {};
  let hasField = false;
  if (opts.functionName !== undefined) {
    loc.functionName = opts.functionName;
    hasField = true;
  }
  if (opts.matchPath !== undefined) {
    loc.matchPath = opts.matchPath;
    hasField = true;
  }
  if (opts.line !== undefined) {
    loc.line = opts.line;
    hasField = true;
  }
  if (!hasField) return undefined;
  return loc;
}

export function pushWarning(
  warnings: LintWarning[],
  base: Omit<LintWarning, 'location'>,
  locationOpts?: { functionName?: string; matchPath?: string; line?: number },
): void {
  const warning: LintWarning = { ...base };
  if (locationOpts !== undefined) {
    const location = buildWarningLocation(locationOpts);
    if (location !== undefined) warning.location = location;
  }
  warnings.push(warning);
}

/** The load check's source size refusal, with production's message, so lint and load agree. */
export function checkSourceSize(source: string, warnings: LintWarning[]): void {
  const violation = sourceSizeViolation(source);
  if (violation === null) return;
  warnings.push({
    rule: 'SOURCE_SIZE',
    severity: 'error',
    message: violation.message,
    fix: 'Reduce string literals, remove comments, or split into smaller match blocks.',
  });
}

export function checkLetBindings(functions: FunctionDef[], warnings: LintWarning[]): void {
  for (const fn of functions) {
    if (fn.lets.length > LET_LIMIT) {
      const line = (fn.returnLoc ?? fn.loc)?.line;
      pushWarning(
        warnings,
        {
          rule: 'LET_LIMIT',
          severity: 'error',
          message: `Function '${fn.name}' has ${fn.lets.length} let bindings. Limit is ${LET_LIMIT}.`,
          fix: 'Inline some let expressions into the return statement, or split the function.',
        },
        { functionName: fn.name, line },
      );
    }
  }
}

export function checkNestingDepth(
  violations: readonly CompileLimitViolation[],
  warnings: LintWarning[],
): void {
  const reported = new Set<string>();
  for (const violation of violations) {
    if (violation.code !== 'NESTING_DEPTH') continue;
    const key = `${violation.functionName ?? ''}@${violation.line ?? ''}`;
    if (reported.has(key)) continue;
    reported.add(key);
    let subject = 'An allow rule';
    if (violation.functionName !== undefined) {
      subject = `Function '${violation.functionName}'`;
    } else if (violation.line !== undefined) {
      subject = `The rule at line ${violation.line}`;
    }
    pushWarning(
      warnings,
      {
        rule: 'NESTING_DEPTH',
        severity: 'error',
        message: `${subject} nests an expression deeper than ${NESTING_LEVEL_LIMIT} levels. Production rejects the ruleset: "${NESTING_MESSAGE}"`,
        fix: 'Remove redundant parentheses, or move a nested group into its own function and call it.',
      },
      { functionName: violation.functionName, line: violation.line },
    );
  }
}

export function checkSlashStartsPath(
  violations: readonly CompileLimitViolation[],
  warnings: LintWarning[],
): void {
  for (const violation of violations) {
    if (violation.code !== 'SLASH_STARTS_PATH') continue;
    let where = 'in an allow rule';
    if (violation.functionName !== undefined) {
      let lineSuffix = '';
      if (violation.line !== undefined) {
        lineSuffix = ` at line ${violation.line}`;
      }
      where = `in function '${violation.functionName}'${lineSuffix}`;
    } else if (violation.line !== undefined) {
      where = `in the rule at line ${violation.line}`;
    }
    pushWarning(
      warnings,
      {
        rule: 'SLASH_STARTS_PATH',
        severity: 'error',
        message: `A '/' ${where} is directly followed by a character other than whitespace, which production reads as the start of a path. Production rejects the ruleset: "${SLASH_STARTS_PATH_MESSAGE}"`,
        fix: "To divide, put whitespace after the '/': `a / b`.",
      },
      { functionName: violation.functionName, line: violation.line },
    );
  }
}

export function checkGlobMatchCount(
  violations: readonly CompileLimitViolation[],
  warnings: LintWarning[],
): void {
  for (const violation of violations) {
    if (violation.code !== 'GLOB_MATCH_COUNT') continue;
    pushWarning(
      warnings,
      {
        rule: 'GLOB_MATCH_COUNT',
        severity: 'error',
        message: violation.message,
        fix: 'Restructure match blocks so a path contains at most one recursive wildcard `{name=**}`.',
      },
      { matchPath: violation.scope, line: violation.line },
    );
  }
}

export function checkAdditionalCompileRejections(
  ast: FirestoreRules,
  violations: readonly CompileLimitViolation[],
  warnings: LintWarning[],
): void {
  for (const violation of violations) {
    switch (violation.code) {
      case 'UNSUPPORTED_RULES_VERSION':
        pushWarning(
          warnings,
          {
            rule: 'UNSUPPORTED_RULES_VERSION',
            severity: 'error',
            message: violation.message,
            fix: "Set rules_version to '1', '2', or '2+modules'.",
          },
          { line: violation.line },
        );
        break;
      case 'UNRESOLVED_MODULES':
        if (ast.version !== '2+modules') {
          pushWarning(
            warnings,
            {
              rule: 'UNRESOLVED_MODULES',
              severity: 'error',
              message: violation.message,
              fix: "Set `rules_version = '2+modules';` or resolve module imports before compiling.",
            },
            { line: violation.line },
          );
        }
        break;
      case 'INVALID_REGEX_PATTERN':
        pushWarning(
          warnings,
          {
            rule: 'INVALID_REGEX_PATTERN',
            severity: 'error',
            message: violation.message,
            fix: 'Rewrite the regular expression using RE2-compatible syntax (no lookahead, lookbehind, or backreferences).',
          },
          { functionName: violation.functionName, line: violation.line },
        );
        break;
      case 'FUNCTION_REDEFINED':
        pushWarning(
          warnings,
          {
            rule: 'FUNCTION_REDEFINED',
            severity: 'error',
            message: violation.message,
            fix: `Rename or remove the duplicate declaration of '${violation.functionName ?? 'function'}' in ${violation.scope ?? 'this scope'}.`,
          },
          {
            functionName: violation.functionName,
            matchPath: violation.scope,
            line: violation.line,
          },
        );
        break;
      case 'DOUBLE_MINUS':
        pushWarning(
          warnings,
          {
            rule: 'DOUBLE_MINUS',
            severity: 'error',
            message: violation.message,
            fix: "Remove the duplicate unary '-' or rewrite using '0 - x'.",
          },
          { functionName: violation.functionName, line: violation.line },
        );
        break;
      case 'INVALID_NUMBER_LITERAL':
        pushWarning(
          warnings,
          {
            rule: 'INVALID_NUMBER_LITERAL',
            severity: 'error',
            message: violation.message,
            fix: 'Keep integer literals within signed 64-bit bounds (-9223372036854775808 to 9223372036854775807), or write a float literal.',
          },
          { functionName: violation.functionName, line: violation.line },
        );
        break;
    }
  }
}
