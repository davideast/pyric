import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPE_CENSUS_ENTRY = join(HERE, '__public-surface-census__.ts');

/**
 * Firebase uses a leading underscore for implementation exports that happen to
 * escape through a runtime barrel. They are not part of the documented modular
 * API and therefore never belong in a public-surface denominator.
 *
 * This is deliberately structural rather than a hand-maintained exclusion
 * list. A newly added `_privateThing` is private immediately, while every
 * non-underscore export remains public until Firebase removes it.
 */
export function isPublicExportName(name: string): boolean {
  return !name.startsWith('_');
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
  skipLibCheck: true,
};

function resolveDeclaration(specifier: string): string {
  const resolved = ts.resolveModuleName(specifier, TYPE_CENSUS_ENTRY, COMPILER_OPTIONS, ts.sys).resolvedModule;
  if (!resolved) throw new Error(`Cannot resolve public declaration entry for '${specifier}'`);
  return resolved.resolvedFileName;
}

/**
 * Enumerate the public type namespace exported by one or more package entry
 * points. Aliased re-exports are resolved before checking `SymbolFlags.Type`,
 * so `export type { FirebaseApp }` and direct interface declarations receive
 * the same treatment. Classes and enums participate in both runtime and type
 * coverage because TypeScript exposes them in both namespaces.
 */
export function publicTypeExportNames(specifiers: string[]): string[] {
  const roots = [...new Set(specifiers.map(resolveDeclaration))];
  const program = ts.createProgram(roots, COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const names = new Set<string>();

  for (const root of roots) {
    const source = program.getSourceFile(root);
    if (!source) throw new Error(`TypeScript did not load declaration entry '${root}'`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`TypeScript found no module symbol for declaration entry '${root}'`);

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (!isPublicExportName(exported.name)) continue;
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(exported)
        : exported;
      if ((target.flags & ts.SymbolFlags.Type) !== 0) names.add(exported.name);
    }
  }

  return [...names].sort();
}
