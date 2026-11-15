import type { FirestoreRules, FunctionDef } from './FirestoreAST.js';
import type { CompileLimitOptions, CompileLimitViolation } from './compile-limits.js';

/**
 * Compile-time rejections for Pyric module-only syntax (`rules_version = '2+modules'`,
 * `import` statements, and `export` function modifiers) when compiling directly
 * without prior module lowering.
 */
export function moduleSyntaxViolations(
  ast: FirestoreRules,
  functions: readonly FunctionDef[],
  options?: CompileLimitOptions,
): CompileLimitViolation[] {
  const out: CompileLimitViolation[] = [];
  if (
    !options?.allowUnresolvedImports &&
    (ast.version === '2+modules' || (ast.imports?.length ?? 0) > 0)
  ) {
    const importLine = ast.imports?.[0]?.loc?.line ?? ast.loc?.line ?? 1;
    out.push({
      code: 'UNRESOLVED_MODULES',
      message: "Rules source uses '2+modules' or import statements that must be resolved before compilation.",
      line: importLine,
    });
  }
  if (ast.version !== '2+modules') {
    for (const fn of functions) {
      if (!fn.exported) continue;
      const violation: CompileLimitViolation = {
        code: 'UNRESOLVED_MODULES',
        message: `Function '${fn.name}' uses 'export', which requires rules_version = '2+modules'.`,
        functionName: fn.name,
      };
      if (fn.loc !== undefined) violation.line = fn.loc.line;
      out.push(violation);
    }
  }
  return out;
}
