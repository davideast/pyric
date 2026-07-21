/**
 * Pure `2+modules` resolution core — NO node imports. Disk access is
 * injected via {@link ModuleFileReader} so browser bundles that reach this
 * module (via `resolver-browser.js`, the simulator wiring, or rules tools)
 * never pull `fs`/`path`/`url`. The node-flavored public API
 * (`resolveModules` with real disk reads) lives in `./resolver.js`.
 */
import { parseToASTOrError, parseFunctions } from '../grammar/FirestoreParser.js';
import { assembleRules } from '../grammar/FirestoreAssembler.js';
import type { FunctionDef, Expression } from '../grammar/FirestoreAST.js';
import { RULES_BUILTIN_FUNCTIONS } from '../grammar/builtin-functions.js';
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
 * imports (priority 2) and the on-disk stdlib fallback (priority 4). The
 * node entry (`./resolver.js`) supplies a real reader; browser consumers
 * (`./resolver-browser.js`) pass `null` — they pre-supply every module via
 * `options.modules`, so the disk paths are unreachable there by
 * construction, and this module stays free of `fs`/`path`/`url` imports
 * (they used to leak into browser bundles through the static import chain).
 */
export interface ModuleFileReader {
  /** Read `<basePath>/<moduleName>.rules`. Null when unreadable. */
  readRelative(basePath: string, moduleName: string): string | null;
  /** Read `<stdlib>/<moduleName>.rules` from the package's on-disk stdlib.
   *  Null when unreadable. */
  readStdlib(moduleName: string): string | null;
}

export type ResolveResult =
  | { success: true; data: { resolved: string; modules: string[]; bundledModules: string[] } }
  | { success: false; error: { code: string; message: string } };

export interface ResolveOptions {
  basePath?: string;
  modules?: Record<string, string>;
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

// ---- Transitive dependency resolution ----

function findTransitiveDeps(
  fnName: string,
  allFunctions: Map<string, FunctionDef>,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(fnName)) return [];
  visited.add(fnName);
  const fn = allFunctions.get(fnName);
  if (!fn) return [];
  const deps: string[] = [];
  const calls = collectCalls(fn.body);
  for (const binding of fn.lets) {
    calls.push(...collectCalls(binding.value));
  }
  for (const call of calls) {
    if (allFunctions.has(call) && !RULES_BUILTIN_FUNCTIONS.has(call)) {
      deps.push(call);
      deps.push(...findTransitiveDeps(call, allFunctions, visited));
    }
  }
  return deps;
}

// ---- Module loading ----

function loadModuleFromContent(content: string, moduleName: string, bundled: boolean): LoadResult {
  const functions = parseFunctions(content);
  if (!functions) {
    return { success: false, error: { code: 'PARSE_FAILED', message: `Failed to parse module '${moduleName}'` } };
  }
  return { success: true, functions, bundled };
}

function isRelativeImport(moduleName: string): boolean {
  return moduleName.startsWith('./') || moduleName.startsWith('../');
}

export function loadModuleWith(
  reader: ModuleFileReader | null,
  moduleName: string,
  options?: ResolveOptions,
  bundledSuppliedModules: ReadonlySet<string> = new Set(),
): LoadResult {
  // Priority 1: explicit modules map
  if (options?.modules && moduleName in options.modules) {
    return loadModuleFromContent(
      options.modules[moduleName], moduleName, bundledSuppliedModules.has(moduleName),
    );
  }

  // Priority 2: relative path from basePath
  if (isRelativeImport(moduleName) && options?.basePath) {
    const filePath = `${options.basePath}/${moduleName}.rules`;
    const content = reader?.readRelative(options.basePath, moduleName) ?? null;
    if (content === null) {
      return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' not found at ${filePath}` } };
    }
    return loadModuleFromContent(content, moduleName, false);
  }

  // Priority 3: relative path without basePath
  if (isRelativeImport(moduleName)) {
    return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' requires basePath for relative imports` } };
  }

  // Priority 4: stdlib (on disk — node only; browser callers pre-supply
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

  // 2. Check for module version (exact match)
  if (ast.version !== '2+modules') {
    return { success: false, error: { code: 'NOT_MODULE_SOURCE', message: `Version '${ast.version}' is not a module source` } };
  }

  if (ast.service.name !== 'cloud.firestore' && ast.service.name !== 'firebase.storage') {
    return {
      success: false,
      error: {
        code: 'UNSUPPORTED_SERVICE',
        message: `Module resolution does not support service '${ast.service.name}'`,
      },
    };
  }

  if (ast.imports.length === 0) {
    ast.version = '2';
    return { success: true, data: { resolved: assembleRules(ast), modules: [], bundledModules: [] } };
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
  for (const [fnName, fn] of allModuleFunctions) {
    const origin = functionOrigin.get(fnName);
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
          message: `Function '${fnName}' in module '${origin}' cannot call '${foreignCall}' from another module`,
        },
      };
    }
  }

  // 4. Collect requested functions + transitive dependencies
  const needed = new Set<string>();
  for (const imp of ast.imports) {
    for (const fnName of imp.functions) {
      needed.add(fnName);
      for (const dep of findTransitiveDeps(fnName, allModuleFunctions)) {
        needed.add(dep);
      }
    }
  }

  // 5. Build injection list (deps before dependents)
  const injected: FunctionDef[] = [];
  const added = new Set<string>();

  function addWithDeps(fnName: string) {
    if (added.has(fnName)) return;
    added.add(fnName); // Mark early to prevent circular re-entry
    const fn = allModuleFunctions.get(fnName);
    if (!fn) return;
    // Add dependencies first (recursive)
    const calls = collectCalls(fn.body);
    for (const binding of fn.lets) {
      calls.push(...collectCalls(binding.value));
    }
    for (const call of calls) {
      if (allModuleFunctions.has(call) && !RULES_BUILTIN_FUNCTIONS.has(call)) {
        addWithDeps(call);
      }
    }
    injected.push({ ...fn, exported: false });
  }

  for (const imp of ast.imports) {
    for (const fnName of imp.functions) {
      addWithDeps(fnName);
    }
  }

  const injectedNames = new Set(injected.map((fn) => fn.name));
  const globalFunctions = new Map((ast.functions ?? []).map((fn) => [fn.name, fn]));
  const serviceFunctionNames = new Set((ast.service.functions ?? []).map((fn) => fn.name));
  const globalCallsServiceScope = (fn: FunctionDef, visiting: ReadonlySet<string>): boolean => {
    if (visiting.has(fn.name)) return false;
    const next = new Set([...visiting, fn.name]);
    const calls = [...fn.lets.flatMap(({ value }) => collectCalls(value)), ...collectCalls(fn.body)];
    return calls.some((call) => injectedNames.has(call) ||
      serviceFunctionNames.has(call) ||
      globalFunctions.has(call) && globalCallsServiceScope(globalFunctions.get(call)!, next));
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
          .map((args) => ({ args, provenances: [], receiverTypes: [] })),
      ];
      const argumentSets = callSites.length > 0
        ? callSites
        : [{ args: [], provenances: [], receiverTypes: [] }];
      for (const { args, provenances, receiverTypes } of argumentSets) {
        const requirement = incompatibleFunction(
          fn,
          ast.service.name,
          allModuleFunctions,
          args,
          receiverTypes,
          provenances,
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

  return {
    success: true,
    data: { resolved: assembleRules(ast), modules: modulesUsed, bundledModules: bundledModulesUsed },
  };
}
