/**
 * Lint a rules file with the linter for its service.
 *
 * Firestore and Storage rules share one language (`service
 * cloud.firestore` / `service firebase.storage`), so both go through
 * `lintFirestoreRules`. Realtime Database rules are a JSON document of
 * expression strings and have their own compiler and checker; handing that
 * JSON to the Firestore parser reports a parse error on every valid ruleset.
 */
import { rtdbRules } from 'pyric/rules';
import { lintFirestoreRules } from 'pyric/rules/internal';

export type RulesService = 'firestore' | 'rtdb';

export interface RulesLintFinding {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  /** Where in the ruleset the finding applies, when known. */
  where?: string;
  fix?: string;
}

export interface RulesLintReport {
  service: RulesService;
  parseError?: { message: string; line?: number; column?: number; expected?: string };
  findings: RulesLintFinding[];
}

/** Realtime Database rules are JSON; every other rules file is the Firestore/Storage language. */
export function rulesServiceForPath(path: string): RulesService {
  return path.toLowerCase().endsWith('.json') ? 'rtdb' : 'firestore';
}

function lintFirestoreSource(source: string): RulesLintReport {
  const result = lintFirestoreRules(source);
  const findings: RulesLintFinding[] = result.warnings.map((w) => {
    const loc = w.location;
    const where = loc?.functionName
      ? `in ${loc.functionName}`
      : loc?.matchPath
        ? `at ${loc.matchPath}`
        : undefined;
    return {
      severity: w.severity,
      rule: w.rule ?? '',
      message: w.message,
      ...(where ? { where } : {}),
      ...(w.fix ? { fix: w.fix } : {}),
    };
  });
  return {
    service: 'firestore',
    ...(result.parseError
      ? {
          parseError: {
            message: result.parseError.message,
            line: result.parseError.line,
            column: result.parseError.column,
            expected: result.parseError.expected,
          },
        }
      : {}),
    findings,
  };
}

function lintRtdbSource(source: string): RulesLintReport {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (e) {
    return {
      service: 'rtdb',
      parseError: { message: e instanceof Error ? e.message : String(e) },
      findings: [],
    };
  }
  const rules = (json as { rules?: unknown } | null)?.rules;
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    return {
      service: 'rtdb',
      parseError: { message: 'a Realtime Database ruleset is a JSON object with a "rules" object' },
      findings: [],
    };
  }
  try {
    const issues = rtdbRules(json as Parameters<typeof rtdbRules>[0]).lint();
    return {
      service: 'rtdb',
      findings: issues
        .filter((i) => i.severity !== 'info')
        .map((i) => ({
          severity: i.severity === 'error' ? ('error' as const) : ('warning' as const),
          rule: i.code,
          message: i.message,
          ...(i.path
            ? { where: i.rule ? `at ${i.path} ${i.rule}` : `at ${i.path}` }
            : {}),
          ...(i.fix ? { fix: i.fix } : {}),
        })),
    };
  } catch (e) {
    return {
      service: 'rtdb',
      parseError: { message: e instanceof Error ? e.message : String(e) },
      findings: [],
    };
  }
}

export function lintRulesForPath(path: string, source: string): RulesLintReport {
  return rulesServiceForPath(path) === 'rtdb' ? lintRtdbSource(source) : lintFirestoreSource(source);
}
