/**
 * Browser-safe `resolveModules` wrapper.
 *
 * The on-disk resolver in `./resolver.ts` falls back to `readFileSync`
 * when a `2+modules` import names a stdlib module (priority 5). That
 * path can't run in the browser. This wrapper pre-supplies every
 * stdlib module via the resolver's existing `modules: Record<string,
 * string>` option, so the disk-reading priority-5 path never fires —
 * the inline content satisfies the import first.
 *
 * Stdlib modules are addressable by their KEY (`'auth'`, `'membership'`,
 * etc.). Each module is ALSO registered under its conventional path
 * form (`'./stdlib/auth.rules'`, `'./stdlib/membership.rules'`, etc.)
 * so sources that follow the path-style convention from older docs
 * resolve identically.
 *
 * The Node-only `resolveModules` export still works as before for
 * server consumers (it picks up edits to the `.rules` files between
 * builds without re-running the inliner). Browser consumers should
 * call this wrapper instead.
 *
 * Both `basePath` (for relative-path imports during local
 * development on Node) and user-supplied `modules` (to override the
 * stdlib content) are forwarded — user-supplied entries win over
 * `STDLIB_INLINE` so callers can shadow a stdlib module with their
 * own copy when needed.
 *
 * BROWSER-CLEAN by construction: binds the pure core (`resolver-core.js`)
 * with NO disk reader — this module must never import `./resolver.js`
 * (the node wrapper), whose static `fs`/`path`/`url` imports used to leak
 * into browser bundles through exactly that edge (caught by the
 * pyric-serve P0 validation). Relative-path imports (`./foo`) therefore
 * resolve via an explicit `options.modules` entry, or via the reader a
 * caller passes to `resolveModulesWithFiles`; this module never reads a file
 * itself.
 */

import { assembleRules } from '../grammar/FirestoreAssembler.js';
import type { FirestoreRules, FunctionDef, ImportDecl, MatchBlock } from '../grammar/FirestoreAST.js';
import { parseToAST } from '../grammar/FirestoreParser.js';
import { isLocalRelativeModuleSpecifier } from '../grammar/function-scopes.js';
import { allServiceBlocks, isStorageServiceName, topLevelMatches } from '../grammar/service-blocks.js';
import {
  readAuthoredSourceMap,
  resolveAuthoredLoc,
  resolveAuthoredSourceLoc,
  resolveModulesWith,
  type AuthoredSourceLoc,
  type AuthoredSourceMap,
  type ModuleFileReader,
  type ResolveOptions,
  type ResolveResult,
} from './resolver-core.js';
import { STDLIB_INLINE } from './stdlib-content.js';

export const AUTHORED_ROOT_SOURCE_FILE = '__authored_root__.rules';

/**
 * Build a `modules` map that accepts both `'<key>'` and
 * `'./stdlib/<key>.rules'` forms of every stdlib module. Cheap —
 * doubles the entry count but the inline content is shared by
 * reference, not duplicated.
 */
function buildStdlibModuleMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, content] of Object.entries(STDLIB_INLINE)) {
    out[key] = content;
    out[`./stdlib/${key}.rules`] = content;
  }
  return out;
}

const STDLIB_WITH_PATH_ALIASES = buildStdlibModuleMap();
const BUNDLED_STDLIB_NAMES = new Set(Object.keys(STDLIB_WITH_PATH_ALIASES));

function resolveWithInlinedStdlib(
  reader: ModuleFileReader | null,
  source: string,
  options?: ResolveOptions,
): ResolveResult {
  const callerEntries = Object.entries(options?.modules ?? {});
  const callerModules = Object.fromEntries(callerEntries);
  const callerModuleNames = new Set(callerEntries.map(([name]) => name));
  const bundledModules = new Set(
    [...BUNDLED_STDLIB_NAMES].filter((name) => !callerModuleNames.has(name)),
  );
  return resolveModulesWith(reader, source, {
    ...options,
    modules: {
      ...STDLIB_WITH_PATH_ALIASES,
      ...callerModules,
    },
  }, bundledModules);
}

export function resolveModulesBrowser(
  source: string,
  options?: ResolveOptions,
): ResolveResult {
  return resolveWithInlinedStdlib(null, source, options);
}

export { isLocalRelativeModuleSpecifier };

export interface ModuleAnalysisDiagnostic {
  code: string;
  message: string;
  line: number;
}

export function findModuleErrorImportLine(
  imports: readonly ImportDecl[] | undefined,
  errorMessage: string,
  fallbackLine = 1,
): number {
  if (!imports || imports.length === 0) return fallbackLine;
  const byModule = imports.find((imp) => errorMessage.includes(`'${imp.module}'`));
  if (byModule?.loc?.line !== undefined) return byModule.loc.line;
  const byFn = imports.find((imp) => imp.functions.some((fn: string) => errorMessage.includes(`'${fn}'`)));
  if (byFn?.loc?.line !== undefined) return byFn.loc.line;
  return imports[0]?.loc?.line ?? fallbackLine;
}

function remapLoc(
  loc: { line: number; col: number } | undefined,
  sourceMap: AuthoredSourceMap,
  imports: readonly ImportDecl[],
  fallbackLine: number,
): void {
  if (loc === undefined) return;
  const entry = sourceMap.get(loc.line);
  if (entry === undefined) return;
  if (entry.authoredFile === AUTHORED_ROOT_SOURCE_FILE) {
    loc.line = entry.authoredLine;
    loc.col = entry.authoredCol;
    return;
  }
  const imp = imports.find((item) => item.module === entry.authoredFile) ?? imports[0];
  loc.line = imp?.loc?.line ?? fallbackLine;
  loc.col = imp?.loc?.col ?? 1;
}

function remapAstLocations(
  ast: FirestoreRules,
  sourceMap: AuthoredSourceMap,
  imports: readonly ImportDecl[],
  fallbackLine: number,
): void {
  if (sourceMap.size === 0) return;
  const remapFn = (fn: FunctionDef) => {
    remapLoc(fn.loc, sourceMap, imports, fallbackLine);
    remapLoc(fn.returnLoc, sourceMap, imports, fallbackLine);
    for (const binding of fn.lets) remapLoc(binding.loc, sourceMap, imports, fallbackLine);
  };
  const remapMatch = (match: MatchBlock) => {
    remapLoc(match.loc, sourceMap, imports, fallbackLine);
    for (const allow of match.allows) remapLoc(allow.loc, sourceMap, imports, fallbackLine);
    for (const fn of match.functions) remapFn(fn);
    for (const child of match.children) remapMatch(child);
  };
  for (const fn of ast.functions ?? []) remapFn(fn);
  for (const service of allServiceBlocks(ast)) {
    remapLoc(service.loc, sourceMap, imports, fallbackLine);
    for (const fn of service.functions ?? []) remapFn(fn);
    for (const root of topLevelMatches(service)) remapMatch(root);
  }
}

export function resolveBundledModulesWithDiagnostics(
  ast: FirestoreRules,
  rawSource?: string,
  options?: { targetService?: 'cloud.firestore' | 'firebase.storage' },
): { ast: FirestoreRules; resolutionError?: ModuleAnalysisDiagnostic } {
  if (ast.version !== '2+modules' || !ast.imports || ast.imports.length === 0) {
    return { ast };
  }
  const localRelativeImports = ast.imports.filter((imp) => isLocalRelativeModuleSpecifier(imp.module));
  const bundledImports = ast.imports.filter((imp) => !isLocalRelativeModuleSpecifier(imp.module));
  if (bundledImports.length === 0) {
    return { ast };
  }
  const targetService: 'cloud.firestore' | 'firebase.storage' =
    options?.targetService ?? (isStorageServiceName(ast.service?.name) ? 'firebase.storage' : 'cloud.firestore');
  const usesRawSource = localRelativeImports.length === 0 && rawSource !== undefined;
  const candidateSource = usesRawSource
    ? rawSource
    : assembleRules({ ...ast, imports: bundledImports });
  const resolved = resolveModulesBrowser(candidateSource, {
    targetService,
    sourceFile: AUTHORED_ROOT_SOURCE_FILE,
  });
  if (!resolved.success) {
    return {
      ast,
      resolutionError: {
        code: resolved.error.code,
        message: resolved.error.message,
        line: findModuleErrorImportLine(bundledImports, resolved.error.message, ast.loc?.line ?? 1),
      },
    };
  }
  const resolvedAst = parseToAST(resolved.data.resolved);
  if (!resolvedAst) {
    return { ast };
  }
  if (usesRawSource) {
    remapAstLocations(
      resolvedAst,
      readAuthoredSourceMap(resolved.data.resolved),
      bundledImports,
      ast.loc?.line ?? 1,
    );
  }
  if (localRelativeImports.length > 0) {
    resolvedAst.version = '2+modules';
    resolvedAst.imports = localRelativeImports;
  }
  return { ast: resolvedAst };
}

/**
 * Pre-resolve bundled stdlib imports on a `2+modules` AST for static analysis
 * (`lint()`, `lintFirestoreRules()`, `validateFirestoreRules()`). Preserves any
 * local relative imports (`./...`, `../...`) when no filesystem reader is
 * available, and leaves the input AST untouched when stdlib resolution fails
 * so invalid/unexported module imports surface as unresolved symbols.
 */
export function resolveBundledModulesForAnalysis(
  ast: FirestoreRules,
  rawSource?: string,
  options?: { targetService?: 'cloud.firestore' | 'firebase.storage' },
): FirestoreRules {
  return resolveBundledModulesWithDiagnostics(ast, rawSource, options).ast;
}

/**
 * Resolve with the inlined stdlib and a caller-supplied reader for relative
 * imports, which resolve from `options.basePath`. The stdlib never touches
 * the reader, so a runtime without the package's stdlib files on disk (a
 * compiled binary, a dev server) still resolves stdlib imports.
 */
export function resolveModulesWithFiles(
  source: string,
  readRelative: ModuleFileReader['readRelative'],
  options: ResolveOptions & { basePath: string },
): ResolveResult {
  return resolveWithInlinedStdlib({ readRelative, readStdlib: () => null }, source, options);
}

export {
  resolveAuthoredSourceLoc,
  resolveAuthoredLoc,
  readAuthoredSourceMap,
  type AuthoredSourceLoc,
  type AuthoredSourceMap,
};
export { STDLIB_INLINE };
export type { ResolveResult, ResolveOptions };

