/**
 * Pure `2+modules` resolution core — NO node imports. Disk access is
 * injected via {@link ModuleFileReader} so browser bundles that reach this
 * module (via `resolver-browser.js`, the simulator wiring, or rules tools)
 * never pull `fs`/`path`/`url`. The node-flavored public API
 * (`resolveModules` with real disk reads) lives in `./resolver.js`.
 */
import { parseToASTOrError, parseFunctions } from '../grammar/FirestoreParser.js';
import { assembleRules, assembleRulesWithSourceMap, type RulesSourceMapEntry } from '../grammar/FirestoreAssembler.js';
import type { FunctionDef, Expression, FirestoreRules, MatchBlock } from '../grammar/FirestoreAST.js';
import { RULES_BUILTIN_FUNCTIONS } from '../grammar/builtin-functions.js';
import { STDLIB_MODULE_EVIDENCE } from './stdlib-services.generated.js';
import {
  incompatibleFunction,
  incompatibleStdlibExport,
} from './service-compatibility.js';
import {
  prefixPrivateFunctions,
} from './resolver-transform.js';
import {
  collectFunctionCalls,
  moduleCallSites,
  type ModuleCallSite,
} from './resolver-call-sites.js';
export {
  prefixPrivateFunctions,
  rewriteCalls,
  sanitizeModuleName,
} from './resolver-transform.js';
export { STDLIB_SERVICE_CONTRACT_MODULES } from './service-compatibility.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

/**
 * Injectable disk access for the two load paths that read files: relative
 * imports (priority 2) and the on-disk stdlib fallback (priority 5). The
 * node entry (`./resolver.js`) supplies a real reader; browser consumers
 * (`./resolver-browser.js`) pass `null` — they pre-supply every module via
 * `options.modules`, so the disk paths are unreachable there by
 * construction, and this module stays free of `fs`/`path`/`url` imports
 * (they used to leak into browser bundles through the static import chain).
 */
export interface ModuleFileReader {
  /** Read `<basePath>/<moduleName>.rules` (or an explicit `.rules` path). Null when unreadable. */
  readRelative(basePath: string, moduleName: string): string | null;
  /** Read `<stdlib>/<moduleName>.rules` from the package's on-disk stdlib.
   *  Null when unreadable. */
  readStdlib(moduleName: string): string | null;
}

export type ResolveResult =
  | { success: true; data: {
    resolved: string;
    modules: string[];
    bundledModules: string[];
    evidenceIds: string[];
    sourceMap?: RulesSourceMapEntry[];
  } }
  | { success: false; error: { code: string; message: string } };

export interface ResolveOptions {
  basePath?: string;
  modules?: Record<string, string>;
  sourceFile?: string;
}

type LoadResult =
  | { success: true; functions: FunctionDef[]; bundled: boolean }
  | { success: false; error: { code: string; message: string } };

// ---- Function call collection (for transitive deps) ----

function collectCalls(expr: Expression): string[] {
  return collectFunctionCalls(expr).map(({ name }) => name);
}

function functionCallSites(
  functions: ReadonlyMap<string, FunctionDef>,
  functionName: string,
): readonly Expression[][] {
  const expressions = [...functions.values()].flatMap((fn) => [
    ...fn.lets.map(({ value }) => value),
    fn.body,
  ]);
  return expressions.flatMap(collectFunctionCalls)
    .filter(({ name }) => name === functionName)
    .map(({ args }) => args);
}

// ---- Module loading ----

function loadModuleFromContent(content: string, moduleName: string, bundled: boolean): LoadResult {
  const functions = parseFunctions(content, moduleName);
  const isFunctionsNull = functions === null;
  if (isFunctionsNull) {
    return { success: false, error: { code: 'PARSE_FAILED', message: `Failed to parse module '${moduleName}'` } };
  }
  return { success: true, functions: functions!, bundled };
}

function isRelativeImport(moduleName: string): boolean {
  return moduleName.startsWith('./') || moduleName.startsWith('../');
}

function conventionalStdlibKey(moduleName: string): string | null {
  return /^\.\/stdlib\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\.rules$/
    .exec(moduleName)?.[1] ?? null;
}

export function loadModuleWith(
  reader: ModuleFileReader | null,
  moduleName: string,
  options?: ResolveOptions,
  bundledSuppliedModules: ReadonlySet<string> = new Set(),
): LoadResult {
  // Priority 1: explicit modules map
  if (options?.modules && Object.prototype.hasOwnProperty.call(options.modules, moduleName)) {
    return loadModuleFromContent(
      options.modules[moduleName], moduleName, bundledSuppliedModules.has(moduleName),
    );
  }

  // Priority 2: relative path from basePath
  if (isRelativeImport(moduleName) && options?.basePath) {
    const filePath = `${options.basePath}/${moduleName}${moduleName.endsWith('.rules') ? '' : '.rules'}`;
    const content = reader?.readRelative(options.basePath, moduleName) ?? null;
    if (content !== null) return loadModuleFromContent(content, moduleName, false);
    if (!conventionalStdlibKey(moduleName)) {
      return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' not found at ${filePath}` } };
    }
  }

  // Priority 3: conventional stdlib path alias. An explicit modules entry or
  // a real basePath file still wins; only an unresolved alias reaches here.
  const stdlibKey = conventionalStdlibKey(moduleName);
  if (stdlibKey) {
    const content = reader?.readStdlib(stdlibKey) ?? null;
    if (content === null) {
      return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' not found` } };
    }
    return loadModuleFromContent(content, moduleName, true);
  }

  // Priority 4: relative path without basePath
  if (isRelativeImport(moduleName)) {
    return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' requires basePath for relative imports` } };
  }

  // Priority 5: stdlib (on disk — node only; browser callers pre-supply
  // stdlib via options.modules and never reach here for known modules)
  const content = reader?.readStdlib(moduleName) ?? null;
  if (content === null) {
    return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' not found` } };
  }
  return loadModuleFromContent(content, moduleName, true);
}

// ---- Main resolver ----

export function resolveModulesWith(
  reader: ModuleFileReader | null,
  source: string,
  options?: ResolveOptions,
  bundledSuppliedModules: ReadonlySet<string> = new Set(),
): ResolveResult {
  // 1. Parse source
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    const { line, column, message } = parsed.error;
    return {
      success: false,
      error: {
        code: 'PARSE_FAILED',
        message: `Failed to parse source at line ${line}, col ${column}: ${message}`,
      },
    };
  }
  const ast = parsed.ast;
  let sourceFile = 'firestore.rules';
  const isModular = ast.version === '2+modules';
  if (isModular) {
    sourceFile = 'firestore.modules.rules';
  }
  const hasOptions = options !== undefined;
  if (hasOptions) {
    const hasSourceFile = options!.sourceFile !== undefined;
    if (hasSourceFile) {
      const isNotEmpty = options!.sourceFile !== '';
      if (isNotEmpty) {
        sourceFile = options!.sourceFile!;
      }
    }
  }
  attachAstSourceFile(ast, sourceFile);

  // 2. Check for module version (exact match)
  if (isModular === false) {
    return { success: false, error: { code: 'NOT_MODULE_SOURCE', message: `Version '${ast.version}' is not a module source` } };
  }

  const isFirestore = ast.service.name === 'cloud.firestore';
  if (isFirestore === false) {
    const isStorage = ast.service.name === 'firebase.storage';
    if (isStorage === false) {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_SERVICE',
          message: `Module resolution does not support service '${ast.service.name}'`,
        },
      };
    }
  }

  const isNoImports = ast.imports.length === 0;
  if (isNoImports) {
    ast.version = '2';
    const assembled = assembleRulesWithSourceMap(ast);
    const sourceMapJson = JSON.stringify(assembled.sourceMap);
    const resolvedWithMap = `${assembled.resolved}// @pyric-source-map: ${sourceMapJson}\n`;
    return { success: true, data: {
      resolved: resolvedWithMap,
      modules: [],
      bundledModules: [],
      evidenceIds: [],
      sourceMap: assembled.sourceMap,
    } };
  }

  const emptyImport = ast.imports.find((imp) => imp.functions.length === 0);
  if (emptyImport) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_FUNCTION',
        message: `Import from '${emptyImport.module}' must request at least one function`,
      },
    };
  }

  // 3. Load all modules and collect exported functions + all functions (for transitive deps)
  const exportedFunctions = new Map<string, FunctionDef>();
  const allModuleFunctions = new Map<string, FunctionDef>();
  const moduleOrigin = new Map<string, string>();
  const functionOrigin = new Map<string, string>();
  const modulesUsed: string[] = [];
  const bundledModulesUsed: string[] = [];
  const privateNamesPerModule = new Map<string, Set<string>>();

  for (const imp of ast.imports) {
    const loaded = loadModuleWith(reader, imp.module, options, bundledSuppliedModules);
    if (!loaded.success) {
      return { success: false, error: loaded.error };
    }
    if (!modulesUsed.includes(imp.module)) modulesUsed.push(imp.module);
    if (loaded.bundled && !bundledModulesUsed.includes(imp.module)) {
      bundledModulesUsed.push(imp.module);
    }

    const originalNames = new Set<string>();
    const originalCollision = loaded.functions.find((fn) => {
      if (originalNames.has(fn.name)) return true;
      originalNames.add(fn.name);
      return false;
    });
    if (originalCollision) {
      return {
        success: false,
        error: {
          code: 'DUPLICATE_FUNCTION',
          message: `Module '${imp.module}' defines duplicate function '${originalCollision.name}'`,
        },
      };
    }

    const builtinCollision = loaded.functions
      .find((fn) => RULES_BUILTIN_FUNCTIONS.has(fn.name));
    if (builtinCollision) {
      return {
        success: false,
        error: {
          code: 'DUPLICATE_FUNCTION',
          message: `Function '${builtinCollision.name}' from module '${imp.module}' conflicts with a Rules builtin`,
        },
      };
    }

    // Track original private names before prefixing (for error messages)
    const privateNames = new Set<string>();
    for (const fn of loaded.functions) {
      if (!fn.exported) privateNames.add(fn.name);
    }
    privateNamesPerModule.set(imp.module, privateNames);

    const prefixed = prefixPrivateFunctions(loaded.functions, imp.module);
    const namesInModule = new Set<string>();
    for (const fn of prefixed) {
      if (namesInModule.has(fn.name)) {
        return {
          success: false,
          error: {
            code: 'DUPLICATE_FUNCTION',
            message: `Module '${imp.module}' defines conflicting function name '${fn.name}'`,
          },
        };
      }
      namesInModule.add(fn.name);
    }
    const moduleExports = new Set(
      prefixed.filter((fn) => fn.exported).map((fn) => fn.name),
    );
    for (const fn of prefixed) {
      const existingOrigin = functionOrigin.get(fn.name);
      if (existingOrigin && existingOrigin !== imp.module) {
        return {
          success: false,
          error: {
            code: 'DUPLICATE_FUNCTION',
            message: `Function '${fn.name}' from module '${imp.module}' conflicts with module '${existingOrigin}'`,
          },
        };
      }
      functionOrigin.set(fn.name, imp.module);
      allModuleFunctions.set(fn.name, fn);

      if (fn.exported) {
        if (exportedFunctions.has(fn.name) && moduleOrigin.get(fn.name) !== imp.module) {
          return {
            success: false,
            error: {
              code: 'DUPLICATE_FUNCTION',
              message: `Function '${fn.name}' exported by both '${moduleOrigin.get(fn.name)}' and '${imp.module}'`,
            },
          };
        }
        exportedFunctions.set(fn.name, fn);
        moduleOrigin.set(fn.name, imp.module);
      }
    }

    // Verify all requested functions exist AND are exported
    for (const fnName of imp.functions) {
      if (!moduleExports.has(fnName)) {
        const isPrivate = privateNamesPerModule.get(imp.module)?.has(fnName);
        const msg = isPrivate
          ? `Function '${fnName}' in module '${imp.module}' is not exported`
          : `Function '${fnName}' not found in module '${imp.module}'`;
        return { success: false, error: { code: 'UNKNOWN_FUNCTION', message: msg } };
      }
      if (ast.service.name === 'cloud.firestore' || ast.service.name === 'firebase.storage') {
        const message = loaded.bundled
          ? incompatibleStdlibExport(ast.service.name, imp.module, fnName)
          : null;
        if (message) {
          return { success: false, error: { code: 'INCOMPATIBLE_FUNCTION', message } };
        }
      }
    }
  }

  const requestedNames = new Set(ast.imports.flatMap((imp) => imp.functions));
  // 4. Validate the reachable call graph while building dependency-first order.
  const injected: FunctionDef[] = [];
  const added = new Set<string>();
  const visiting: string[] = [];
  const traversal: { cycle: string[] | null } = { cycle: null };

  function addWithDeps(fnName: string): void {
    if (traversal.cycle) return;
    const cycleStart = visiting.indexOf(fnName);
    if (cycleStart >= 0) {
      traversal.cycle = [...visiting.slice(cycleStart), fnName];
      return;
    }
    if (added.has(fnName)) return;
    const fn = allModuleFunctions.get(fnName);
    if (!fn) return;
    visiting.push(fnName);
    const calls = collectCalls(fn.body);
    for (const binding of fn.lets) {
      calls.push(...collectCalls(binding.value));
    }
    for (const call of calls) {
      if (allModuleFunctions.has(call) && !RULES_BUILTIN_FUNCTIONS.has(call)) {
        addWithDeps(call);
      }
    }
    visiting.pop();
    if (traversal.cycle) return;
    added.add(fnName);
    injected.push({ ...fn, exported: false });
  }

  for (const imp of ast.imports) {
    for (const fnName of imp.functions) {
      addWithDeps(fnName);
    }
  }
  if (traversal.cycle) {
    return {
      success: false,
      error: {
        code: 'CIRCULAR_DEPENDENCY',
        message: `Recursive module function dependency: ${traversal.cycle.join(' -> ')}`,
      },
    };
  }
  for (const fn of injected) {
    const origin = functionOrigin.get(fn.name);
    const calls = [...fn.lets.flatMap(({ value }) => collectCalls(value)), ...collectCalls(fn.body)];
    const foreignCall = calls.find((call) => {
      const calledOrigin = functionOrigin.get(call);
      return calledOrigin && calledOrigin !== origin && !requestedNames.has(call);
    });
    if (foreignCall) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_FUNCTION',
          message: `Function '${fn.name}' in module '${origin}' cannot call '${foreignCall}' from another module`,
        },
      };
    }
  }

  // 5. Validate source/module scope boundaries and call-site compatibility.
  const injectedNames = new Set(injected.map((fn) => fn.name));
  const globalFunctions = new Map((ast.functions ?? []).map((fn) => [fn.name, fn]));
  const serviceFunctionNames = new Set((ast.service.functions ?? []).map((fn) => fn.name));
  const unimportedModuleCall = (
    expressions: readonly Expression[],
    sourceFunctions: ReadonlySet<string>,
  ): string | null => expressions.flatMap(collectCalls).find((name) =>
    exportedFunctions.has(name) && !injectedNames.has(name) && !sourceFunctions.has(name)) ?? null;
  const functionExpressions = (functions: readonly FunctionDef[]): Expression[] =>
    functions.flatMap((fn) => [...fn.lets.map(({ value }) => value), fn.body]);
  const globalNames = new Set(globalFunctions.keys());
  let invalidSourceCall = unimportedModuleCall(
    functionExpressions(ast.functions ?? []),
    globalNames,
  );
  const serviceNames = new Set([...globalNames, ...serviceFunctionNames]);
  invalidSourceCall ??= unimportedModuleCall(
    functionExpressions(ast.service.functions ?? []),
    serviceNames,
  );
  const checkMatchCalls = (
    match: typeof ast.service.match,
    inheritedNames: ReadonlySet<string>,
  ): string | null => {
    const names = new Set([...inheritedNames, ...match.functions.map((fn) => fn.name)]);
    const ownExpressions = [
      ...functionExpressions(match.functions),
      ...match.allows.map(({ condition }) => condition),
    ];
    return unimportedModuleCall(ownExpressions, names) ??
      match.children.map((child) => checkMatchCalls(child, names)).find(Boolean) ?? null;
  };
  invalidSourceCall ??= checkMatchCalls(ast.service.match, serviceNames);
  if (invalidSourceCall) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_FUNCTION',
        message: `Source calls function '${invalidSourceCall}' from module '${moduleOrigin.get(invalidSourceCall)}' without importing it`,
      },
    };
  }
  const globalCallsServiceScope = (fn: FunctionDef, visiting: ReadonlySet<string>): boolean => {
    if (visiting.has(fn.name)) return false;
    const next = new Set([...visiting, fn.name]);
    const calls = [...fn.lets.flatMap(({ value }) => collectCalls(value)), ...collectCalls(fn.body)];
    return calls.some((call) => {
      const globalFunction = globalFunctions.get(call);
      if (globalFunction) return globalCallsServiceScope(globalFunction, next);
      return injectedNames.has(call) || serviceFunctionNames.has(call);
    });
  };
  const invalidGlobal = [...globalFunctions.values()]
    .find((fn) => globalCallsServiceScope(fn, new Set()));
  if (invalidGlobal) {
    return {
      success: false,
      error: {
        code: 'INCOMPATIBLE_FUNCTION',
        message: `Global function '${invalidGlobal.name}' cannot call a service-scoped function`,
      },
    };
  }

  if (ast.service.name === 'firebase.storage' || ast.service.name === 'cloud.firestore') {
    const reachableFunctions = new Map(injected.map((fn) => [fn.name, fn]));
    for (const fn of injected) {
      const callSites: ModuleCallSite[] = [
        ...moduleCallSites(ast, fn.name),
        ...functionCallSites(reachableFunctions, fn.name)
          .map((args) => ({
            arguments: args.map((expression) => ({
              expression,
              provenance: null,
              receiverType: 'unknown' as const,
            })),
          })),
      ];
      const argumentSets = callSites.length > 0
        ? callSites
        : [{ arguments: [] }];
      for (const { arguments: arguments_ } of argumentSets) {
        const requirement = incompatibleFunction(
          fn,
          ast.service.name,
          allModuleFunctions,
          arguments_,
        );
        if (requirement) {
          return {
            success: false,
            error: {
              code: 'INCOMPATIBLE_FUNCTION',
              message: `Function '${fn.name}' requires unsupported ${requirement} for service '${ast.service.name}'`,
            },
          };
        }
      }
    }
  }

  // 6. Check for conflicts with source-defined functions
  const sourceFnNames = new Set([
    ...(ast.functions ?? []).map((fn) => fn.name),
    ...(ast.service.functions ?? []).map((fn) => fn.name),
  ]);
  const collectMatchFunctions = (match: typeof ast.service.match): void => {
    match.functions.forEach((fn) => sourceFnNames.add(fn.name));
    match.children.forEach(collectMatchFunctions);
  };
  collectMatchFunctions(ast.service.match);
  const builtinSourceCollision = [...sourceFnNames]
    .find((name) => RULES_BUILTIN_FUNCTIONS.has(name));
  if (builtinSourceCollision) {
    return {
      success: false,
      error: {
        code: 'DUPLICATE_FUNCTION',
        message: `Source function '${builtinSourceCollision}' conflicts with a Rules builtin`,
      },
    };
  }
  for (const fn of injected) {
    if (sourceFnNames.has(fn.name)) {
      return {
        success: false,
        error: {
          code: 'DUPLICATE_FUNCTION',
          message: `Imported function '${fn.name}' conflicts with a function defined in the source`,
        },
      };
    }
  }

  // 7. Inject functions at service scope so service helpers and every match can see them.
  ast.service.functions = [...injected, ...(ast.service.functions ?? [])];
  ast.version = '2';
  ast.imports = [];

  const evidenceIds = new Set<string>();
  const evidencePrefix = ast.service.name === 'firebase.storage'
    ? 'storage-rules#'
    : 'firestore-rules#';
  for (const moduleName of bundledModulesUsed) {
    const key = conventionalStdlibKey(moduleName) ?? moduleName;
    const moduleEvidence = STDLIB_MODULE_EVIDENCE[
      key as keyof typeof STDLIB_MODULE_EVIDENCE
    ] ?? [];
    for (const evidenceId of moduleEvidence) {
      if (evidenceId.startsWith(evidencePrefix)) evidenceIds.add(evidenceId);
    }
  }

  const assembled = assembleRulesWithSourceMap(ast);
  const sourceMapJson = JSON.stringify(assembled.sourceMap);
  const resolvedWithMap = `${assembled.resolved}// @pyric-source-map: ${sourceMapJson}\n`;
  return {
    success: true,
    data: {
      resolved: resolvedWithMap,
      modules: modulesUsed,
      bundledModules: bundledModulesUsed,
      evidenceIds: [...evidenceIds].sort(),
      sourceMap: assembled.sourceMap,
    },
  };
}

export function attachAstSourceFile(ast: FirestoreRules, file: string): void {
  const hasFunctions = ast.functions !== undefined;
  if (hasFunctions) {
    for (const fn of ast.functions!) {
      const hasLoc = fn.loc !== undefined;
      if (hasLoc) {
        fn.loc!.file = file;
      }
    }
  }
  const hasServiceFunctions = ast.service.functions !== undefined;
  if (hasServiceFunctions) {
    for (const fn of ast.service.functions!) {
      const hasLoc = fn.loc !== undefined;
      if (hasLoc) {
        fn.loc!.file = file;
      }
    }
  }
  const stack: MatchBlock[] = [ast.service.match];
  let stackLength = stack.length;
  while (stackLength > 0) {
    const block = stack.pop()!;
    const hasBlockLoc = block.loc !== undefined;
    if (hasBlockLoc) {
      block.loc!.file = file;
    }
    for (const allow of block.allows) {
      const hasAllowLoc = allow.loc !== undefined;
      if (hasAllowLoc) {
        allow.loc!.file = file;
      }
    }
    for (const fn of block.functions) {
      const hasFnLoc = fn.loc !== undefined;
      if (hasFnLoc) {
        fn.loc!.file = file;
      }
    }
    for (const child of block.children) {
      stack.push(child);
    }
    stackLength = stack.length;
  }
}

export interface AuthoredSourceLoc {
  line: number;
  col: number;
  file: string;
  citation: string;
  expression?: string;
}

export function resolveAuthoredSourceLoc(
  sourceString: string,
  generatedLine?: number,
  generatedCol?: number,
  fallbackFile?: string,
  fallbackExpression?: string,
): AuthoredSourceLoc | undefined {
  const isLineUndefined = generatedLine === undefined;
  if (isLineUndefined) {
    return undefined;
  }
  let line = generatedLine!;
  let col = 1;
  const isColDefined = generatedCol !== undefined;
  if (isColDefined) {
    col = generatedCol!;
  }
  let file = 'firestore.rules';
  const isFallbackDefined = fallbackFile !== undefined;
  if (isFallbackDefined) {
    const isNotEmpty = fallbackFile !== '';
    if (isNotEmpty) {
      file = fallbackFile!;
    }
  }
  let expression: string | undefined = undefined;
  const isExprDefined = fallbackExpression !== undefined;
  if (isExprDefined) {
    expression = fallbackExpression;
  }

  const marker = '// @pyric-source-map: ';
  const markerIdx = sourceString.indexOf(marker);
  const hasMarker = markerIdx !== -1;
  if (hasMarker) {
    const startIdx = markerIdx + marker.length;
    const endIdx = sourceString.indexOf('\n', startIdx);
    let jsonStr = '';
    const hasNewLine = endIdx !== -1;
    if (hasNewLine) {
      jsonStr = sourceString.slice(startIdx, endIdx).trim();
    } else {
      jsonStr = sourceString.slice(startIdx).trim();
    }
    try {
      const sourceMap = JSON.parse(jsonStr) as Array<{
        generatedLine: number;
        authoredLine: number;
        authoredCol: number;
        authoredFile: string;
        expression?: string;
      }>;
      const isArray = Array.isArray(sourceMap);
      if (isArray) {
        for (const entry of sourceMap) {
          const isMatch = entry.generatedLine === line;
          if (isMatch) {
            line = entry.authoredLine;
            col = entry.authoredCol;
            file = entry.authoredFile;
            const hasEntryExpr = entry.expression !== undefined;
            if (hasEntryExpr) {
              expression = entry.expression;
            }
            break;
          }
        }
      }
    } catch (e) {
      // ignore JSON parse errors
    }
  }

  const citation = `${file}:${line}:${col}`;
  const result: AuthoredSourceLoc = { line, col, file, citation };
  const hasFinalExpr = expression !== undefined;
  if (hasFinalExpr) {
    result.expression = expression;
  }
  return result;
}

