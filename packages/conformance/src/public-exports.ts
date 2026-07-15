import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { workspaceSourceEntry } from './workspace-entry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPE_CENSUS_ENTRY = join(HERE, '__public-surface-census__.ts');

/**
 * Type-surface visibility remains structural because the type census does not
 * yet have reviewed per-symbol classifications. Runtime visibility is stricter:
 * exact private names live in the owning surface contract, and this helper must
 * not be used to let a new runtime export bypass review.
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

export function resolvePublicTypeEntry(specifier: string): string {
  const source = workspaceSourceEntry(specifier);
  if (source) return source;
  const resolved = ts.resolveModuleName(specifier, TYPE_CENSUS_ENTRY, COMPILER_OPTIONS, ts.sys).resolvedModule;
  if (resolved) return resolved.resolvedFileName;
  throw new Error(`Cannot resolve public declaration entry for '${specifier}'`);
}

/**
 * Enumerate the public type namespace exported by one or more package entry
 * points. Aliased re-exports are resolved before checking `SymbolFlags.Type`,
 * so `export type { FirebaseApp }` and direct interface declarations receive
 * the same treatment. Classes and enums participate in both runtime and type
 * coverage because TypeScript exposes them in both namespaces.
 */
export function publicTypeExportNames(specifiers: string[]): string[] {
  const roots = [...new Set(specifiers.map(resolvePublicTypeEntry))];
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

/** Enumerate the runtime namespace of a workspace source barrel without
 * evaluating it. This keeps clean-checkout conformance generation independent
 * of package `dist/` while still following TypeScript re-exports. */
export function publicRuntimeExportNamesFromSource(sourcePath: string): string[] {
  const program = ts.createProgram([sourcePath], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(sourcePath);
  if (!source) throw new Error(`TypeScript did not load source entry '${sourcePath}'`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`TypeScript found no module symbol for source entry '${sourcePath}'`);

  return checker.getExportsOfModule(moduleSymbol)
    .filter((exported) => {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(exported)
        : exported;
      return (target.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((exported) => exported.name)
    .sort();
}
