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

let sharedHost: ts.CompilerHost | undefined;

function memoize<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  if (cache.has(key)) return cache.get(key)!;
  const value = compute();
  cache.set(key, value);
  return value;
}

/** Resolve every workspace import in a source census back to authored source,
 * including transitive self-imports such as `pyric/sandbox/admin-firestore`.
 * Without this host, a dirty checkout follows `dist` while a clean checkout
 * leaves those aliases unresolved and silently loses their type symbols.
 *
 * One host serves every program the census builds. Each census surface
 * creates its own program, and every program re-resolves the same default
 * library, `@types` packages and dependency graph. Without a shared cache that
 * repeated file-system probing dominates the model derivation, most visibly in
 * checkouts whose `node_modules` is a deep package store. Source files, file
 * probes and module resolutions do not change during one derivation, so they
 * are memoized for the process. */
function sourceFirstCompilerHost(): ts.CompilerHost {
  if (sharedHost) return sharedHost;
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const sourceFiles = new Map<string, ts.SourceFile | undefined>();
  const fileExists = new Map<string, boolean>();
  const directoryExists = new Map<string, boolean>();
  const reads = new Map<string, string | undefined>();
  const realpaths = new Map<string, string>();
  const directories = new Map<string, string[]>();
  const resolutionCache = ts.createModuleResolutionCache(
    host.getCurrentDirectory(),
    (name) => host.getCanonicalFileName(name),
    COMPILER_OPTIONS,
  );
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalDirectoryExists = host.directoryExists!.bind(host);
  const originalRealpath = host.realpath!.bind(host);
  const originalGetDirectories = host.getDirectories!.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => memoize(
    sourceFiles,
    `${fileName}\0${JSON.stringify(languageVersionOrOptions)}`,
    () => originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate),
  );
  host.fileExists = (fileName) => memoize(fileExists, fileName, () => originalFileExists(fileName));
  host.readFile = (fileName) => memoize(reads, fileName, () => originalReadFile(fileName));
  host.directoryExists = (directory) => memoize(directoryExists, directory, () => originalDirectoryExists(directory));
  host.realpath = (path) => memoize(realpaths, path, () => originalRealpath(path));
  host.getDirectories = (path) => memoize(directories, path, () => originalGetDirectories(path));
  sharedHost = host;
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((specifier) => {
    const source = workspaceSourceEntry(specifier);
    if (source) {
      return {
        resolvedFileName: source,
        extension: source.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts,
        isExternalLibraryImport: false,
      };
    }
    return ts.resolveModuleName(specifier, containingFile, COMPILER_OPTIONS, host, resolutionCache).resolvedModule;
  });
  return host;
}

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
  const program = ts.createProgram(roots, COMPILER_OPTIONS, sourceFirstCompilerHost());
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
  const program = ts.createProgram([sourcePath], COMPILER_OPTIONS, sourceFirstCompilerHost());
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
