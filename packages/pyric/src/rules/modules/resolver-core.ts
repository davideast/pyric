/**
 * Pure `2+modules` resolution core — NO node imports. Disk access is
 * injected via {@link ModuleFileReader} so browser bundles that reach this
 * module (via `resolver-browser.js`, the simulator wiring, or rules tools)
 * never pull `fs`/`path`/`url`. The node-flavored public API
 * (`resolveModules` with real disk reads) lives in `./resolver.js`.
 */
import { parseToASTOrError, parseFunctions } from '../grammar/FirestoreParser.js';
import { assembleRules } from '../grammar/FirestoreAssembler.js';
import type { FunctionDef, Expression, FirestoreRules, MatchBlock } from '../grammar/FirestoreAST.js';
import {
  incompatibleFunction,
  incompatibleStdlibExport,
} from './service-compatibility.js';
import {
  prefixPrivateFunctions,
} from './resolver-transform.js';
export {
  prefixPrivateFunctions,
  rewriteCalls,
  sanitizeModuleName,
} from './resolver-transform.js';
export { STDLIB_SERVICE_CONTRACT_MODULES } from './service-compatibility.js';

const BUILTIN_FUNCTIONS = new Set(['get', 'exists', 'getAfter', 'debug']);

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
  | { success: true; data: { resolved: string; modules: string[] } }
  | { success: false; error: { code: string; message: string } };

export interface ResolveOptions {
  basePath?: string;
  modules?: Record<string, string>;
}

type LoadResult =
  | { success: true; functions: FunctionDef[] }
  | { success: false; error: { code: string; message: string } };

// ---- Function call collection (for transitive deps) ----

type FunctionCallExpression = Extract<Expression, { type: 'functionCall' }>;

function collectFunctionCalls(expr: Expression): FunctionCallExpression[] {
  const calls: FunctionCallExpression[] = [];
  const walk = (e: Expression) => {
    switch (e.type) {
      case 'functionCall': calls.push(e); e.args.forEach(walk); break;
      case 'binaryOp': walk(e.left); walk(e.right); break;
      case 'unaryOp': walk(e.operand); break;
      case 'methodCall': walk(e.object); e.args.forEach(walk); break;
      case 'memberAccess': walk(e.object); break;
      case 'bracketAccess': walk(e.object); walk(e.index); break;
      case 'sliceAccess': walk(e.object); walk(e.start); walk(e.end); break;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
      case 'inExpr': walk(e.element); walk(e.collection); break;
      case 'isExpr': walk(e.value); break;
      case 'listLiteral': e.elements.forEach(walk); break;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
      case 'pathLiteral': e.segments.forEach(segment => {
        if (typeof segment !== 'string') walk(segment);
      }); break;
      case 'literal':
      case 'identifier': break;
      default: assertNever(e);
    }
  };
  walk(expr);
  return calls;
}

function collectCalls(expr: Expression): string[] {
  return collectFunctionCalls(expr).map(({ name }) => name);
}

function moduleCallSites(ast: FirestoreRules, functionName: string): readonly Expression[][] {
  const expressions: Expression[] = [];
  const addFunction = (fn: FunctionDef) => {
    expressions.push(...fn.lets.map(({ value }) => value), fn.body);
  };
  const addMatch = (match: MatchBlock) => {
    match.functions.forEach(addFunction);
    expressions.push(...match.allows.map(({ condition }) => condition));
    match.children.forEach(addMatch);
  };
  ast.functions?.forEach(addFunction);
  ast.service.functions?.forEach(addFunction);
  addMatch(ast.service.match);
  return expressions.flatMap(collectFunctionCalls)
    .filter(({ name }) => name === functionName)
    .map(({ args }) => args);
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
    if (allFunctions.has(call) && !BUILTIN_FUNCTIONS.has(call)) {
      deps.push(call);
      deps.push(...findTransitiveDeps(call, allFunctions, visited));
    }
  }
  return deps;
}

// ---- Module loading ----

function loadModuleFromContent(content: string, moduleName: string): LoadResult {
  const functions = parseFunctions(content);
  if (!functions) {
    return { success: false, error: { code: 'PARSE_FAILED', message: `Failed to parse module '${moduleName}'` } };
  }
  return { success: true, functions };
}

function isRelativeImport(moduleName: string): boolean {
  return moduleName.startsWith('./') || moduleName.startsWith('../');
}

export function loadModuleWith(
  reader: ModuleFileReader | null,
  moduleName: string,
  options?: ResolveOptions,
): LoadResult {
  // Priority 1: explicit modules map
  if (options?.modules && moduleName in options.modules) {
    return loadModuleFromContent(options.modules[moduleName], moduleName);
  }

  // Priority 2: relative path from basePath
  if (isRelativeImport(moduleName) && options?.basePath) {
    const filePath = `${options.basePath}/${moduleName}.rules`;
    const content = reader?.readRelative(options.basePath, moduleName) ?? null;
    if (content === null) {
      return { success: false, error: { code: 'UNKNOWN_MODULE', message: `Module '${moduleName}' not found at ${filePath}` } };
    }
    return loadModuleFromContent(content, moduleName);
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
  return loadModuleFromContent(content, moduleName);
}

// ---- Main resolver ----

export function resolveModulesWith(
  reader: ModuleFileReader | null,
  source: string,
  options?: ResolveOptions,
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

  if (ast.imports.length === 0) {
    ast.version = '2';
    return { success: true, data: { resolved: assembleRules(ast), modules: [] } };
  }

  // 3. Load all modules and collect exported functions + all functions (for transitive deps)
  const exportedFunctions = new Map<string, FunctionDef>();
  const allModuleFunctions = new Map<string, FunctionDef>();
  const moduleOrigin = new Map<string, string>();
  const functionOrigin = new Map<string, string>();
  const modulesUsed: string[] = [];
  const privateNamesPerModule = new Map<string, Set<string>>();

  for (const imp of ast.imports) {
    const loaded = loadModuleWith(reader, imp.module, options);
    if (!loaded.success) {
      return { success: false, error: loaded.error };
    }
    if (!modulesUsed.includes(imp.module)) modulesUsed.push(imp.module);

    // Track original private names before prefixing (for error messages)
    const privateNames = new Set<string>();
    for (const fn of loaded.functions) {
      if (!fn.exported) privateNames.add(fn.name);
    }
    privateNamesPerModule.set(imp.module, privateNames);

    const prefixed = prefixPrivateFunctions(loaded.functions, imp.module);
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
        const message = incompatibleStdlibExport(ast.service.name, imp.module, fnName);
        if (message) {
          return { success: false, error: { code: 'INCOMPATIBLE_FUNCTION', message } };
        }
      }
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
      if (allModuleFunctions.has(call) && !BUILTIN_FUNCTIONS.has(call)) {
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

  if (ast.service.name === 'firebase.storage' || ast.service.name === 'cloud.firestore') {
    for (const fn of injected) {
      const callSites = [
        ...moduleCallSites(ast, fn.name),
        ...functionCallSites(allModuleFunctions, fn.name),
      ];
      const argumentSets = callSites.length > 0 ? callSites : [[]];
      for (const args of argumentSets) {
        const requirement = incompatibleFunction(fn, ast.service.name, allModuleFunctions, args);
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
  const sourceFnNames = new Set(ast.service.match.functions.map(f => f.name));
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

  // 7. Inject functions at root scope and rewrite version
  ast.service.match.functions = [...injected, ...ast.service.match.functions];
  ast.version = '2';
  ast.imports = [];

  return { success: true, data: { resolved: assembleRules(ast), modules: modulesUsed } };
}
