/**
 * Tool-context diagnostic fields. `ctx.lint` is a callable handlers
 * can use to lint an in-flight source body before committing. The
 * shape stays the same regardless of the toggle — when diagnostics
 * are disabled, the impl is a noop that returns `{ warnings: [] }`,
 * so handlers don't need conditional logic.
 *
 * Future ctx-side diagnostics (e.g. `ctx.discoverPaths(uid)`,
 * `ctx.simulate(req)`) land here with the same noop-when-disabled
 * pattern.
 */
import { lintFirestoreRules, type LintWarning as FsLintWarning } from 'pyric/rules';

interface AdaptedWarning {
  severity: 'info' | 'warn' | 'error';
  message: string;
}

function adaptLintWarning(w: FsLintWarning): AdaptedWarning {
  const severity: AdaptedWarning['severity'] = w.severity === 'error' ? 'error' : 'warn';
  const loc = w.location;
  const where = loc?.functionName
    ? `in ${loc.functionName}: `
    : loc?.matchPath
      ? `at ${loc.matchPath}: `
      : '';
  return {
    severity,
    message: `${where}${w.rule ? `[${w.rule}] ` : ''}${w.message}`,
  };
}

export interface DiagnosticsContext {
  lint: (source: string) => { warnings: AdaptedWarning[] };
}

const noopContext: DiagnosticsContext = {
  lint: () => ({ warnings: [] }),
};

export function makeDiagnosticsContext(enabled: boolean): DiagnosticsContext {
  if (!enabled) return noopContext;
  return {
    lint: (source: string) => {
      const result = lintFirestoreRules(source);
      const warnings = result.warnings.map(adaptLintWarning);
      if (result.parseError) {
        warnings.unshift({
          severity: 'error',
          message: `parse error at ${result.parseError.line}:${result.parseError.column} — expected ${result.parseError.expected}`,
        });
      }
      return { warnings };
    },
  };
}
