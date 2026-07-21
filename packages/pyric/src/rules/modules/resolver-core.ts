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

const BUILTIN_FUNCTIONS = new Set(['get', 'exists', 'getAfter', 'debug']);

type RulesServiceName = 'cloud.firestore' | 'firebase.storage';

interface ModuleContract {
  defaultServices: readonly RulesServiceName[];
  exports?: Readonly<Record<string, readonly RulesServiceName[]>>;
}

const FIRESTORE_ONLY: readonly RulesServiceName[] = ['cloud.firestore'];
const FIRESTORE_AND_STORAGE: readonly RulesServiceName[] = ['cloud.firestore', 'firebase.storage'];

/**
 * Reviewed service contracts for the bundled standard library. The catalog is
 * Firestore-first today; only auth and membership have bodies whose complete
 * ambient-binding surface has been admitted for Storage. Keeping this list
 * fail-closed prevents a newly added Firestore module from silently becoming a
 * Storage promise merely because both services share a parser.
 *
 * `exports` permits a mixed module to admit individual functions later without
 * widening every export in the file.
 */
const STDLIB_MODULE_CONTRACTS: Readonly<Record<string, ModuleContract>> = {
  auth: { defaultServices: FIRESTORE_AND_STORAGE },
  membership: { defaultServices: FIRESTORE_AND_STORAGE },
  atomic: { defaultServices: FIRESTORE_ONLY },
  content: { defaultServices: FIRESTORE_ONLY },
  counters: { defaultServices: FIRESTORE_ONLY },
  geometry: { defaultServices: FIRESTORE_ONLY },
  joining: { defaultServices: FIRESTORE_ONLY },
  lifecycle: { defaultServices: FIRESTORE_ONLY },
  lobby: { defaultServices: FIRESTORE_ONLY },
  spaces: { defaultServices: FIRESTORE_ONLY },
  state: { defaultServices: FIRESTORE_ONLY },
  timing: { defaultServices: FIRESTORE_ONLY },
  transitions: { defaultServices: FIRESTORE_ONLY },
  turns: { defaultServices: FIRESTORE_ONLY },
  validation: { defaultServices: FIRESTORE_ONLY },
};

/**
 * Bundled modules that have an explicit service contract. Exported for the
 * stdlib drift test: adding a module to the bundle without classifying its
 * supported services must fail CI instead of silently widening the Storage
 * surface.
 */
export const STDLIB_SERVICE_CONTRACT_MODULES = Object.freeze(
  Object.keys(STDLIB_MODULE_CONTRACTS).sort(),
);

function stdlibContractKey(moduleName: string): string {
  const pathMatch = moduleName.match(/^\.\/stdlib\/([^/]+?)(?:\.rules)?$/);
  return pathMatch?.[1] ?? moduleName;
}

function incompatibleStdlibExport(
  service: RulesServiceName,
  moduleName: string,
  functionName: string,
): string | null {
  const contract = STDLIB_MODULE_CONTRACTS[stdlibContractKey(moduleName)];
  if (!contract) return null;
  const services = contract.exports?.[functionName] ?? contract.defaultServices;
  return services.includes(service)
    ? null
    : `Function '${functionName}' from module '${moduleName}' is not compatible with service '${service}'`;
}

function storageIncompatibility(expr: Expression): string | null {
  const walk = (e: Expression): string | null => {
    switch (e.type) {
      case 'memberAccess': {
        if (
          e.property === 'data' &&
          (e.object.type === 'identifier' && e.object.name === 'resource' ||
            e.object.type === 'memberAccess' &&
            e.object.property === 'resource' &&
            e.object.object.type === 'identifier' &&
            e.object.object.name === 'request')
        ) {
          return `binding '${e.object.type === 'identifier' ? 'resource.data' : 'request.resource.data'}'`;
        }
        return walk(e.object);
      }
      case 'functionCall': {
        if (BUILTIN_FUNCTIONS.has(e.name)) return `function '${e.name}()'`;
        for (const arg of e.args) {
          const issue = walk(arg);
          if (issue) return issue;
        }
        return null;
      }
      case 'methodCall': {
        if (e.object.type === 'identifier') {
          const namespace = e.object.name;
          const allowedNamespaceMethod =
            namespace === 'timestamp' && (e.method === 'date' || e.method === 'value') ||
            namespace === 'duration' && e.method === 'value' ||
            namespace === 'firestore' && (e.method === 'get' || e.method === 'exists');
          if (allowedNamespaceMethod) {
            for (const arg of e.args) {
              const issue = walk(arg);
              if (issue) return issue;
            }
            return null;
          }
        }
        if (e.method !== 'matches' && e.method !== 'split' && e.method !== 'size') {
          return `method '.${e.method}()'`;
        }
        const objectIssue = walk(e.object);
        if (objectIssue) return objectIssue;
        for (const arg of e.args) {
          const issue = walk(arg);
          if (issue) return issue;
        }
        return null;
      }
      case 'binaryOp': return walk(e.left) ?? walk(e.right);
      case 'unaryOp': return walk(e.operand);
      case 'bracketAccess': return walk(e.object) ?? walk(e.index);
      case 'sliceAccess': return walk(e.object) ?? walk(e.start) ?? walk(e.end);
      case 'ternary': return walk(e.condition) ?? walk(e.consequent) ?? walk(e.alternate);
      case 'inExpr': return walk(e.element) ?? walk(e.collection);
      case 'isExpr': return walk(e.value);
      case 'listLiteral':
        for (const element of e.elements) {
          const issue = walk(element);
          if (issue) return issue;
        }
        return null;
      case 'mapLiteral':
        for (const entry of e.entries) {
          const issue = walk(entry.key) ?? walk(entry.value);
          if (issue) return issue;
        }
        return null;
      case 'pathLiteral':
        for (const segment of e.segments) {
          if (typeof segment !== 'string') {
            const issue = walk(segment);
            if (issue) return issue;
          }
        }
        return null;
      default:
        return null;
    }
  };
  return walk(expr);
}

function incompatibleStorageFunction(fn: FunctionDef): string | null {
  for (const binding of fn.lets) {
    const issue = storageIncompatibility(binding.value);
    if (issue) return issue;
  }
  return storageIncompatibility(fn.body);
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

function collectCalls(expr: Expression): string[] {
  const calls: string[] = [];
  const walk = (e: Expression) => {
    switch (e.type) {
      case 'functionCall': calls.push(e.name); e.args.forEach(walk); break;
      case 'binaryOp': walk(e.left); walk(e.right); break;
      case 'unaryOp': walk(e.operand); break;
      case 'methodCall': walk(e.object); e.args.forEach(walk); break;
      case 'memberAccess': walk(e.object); break;
      case 'bracketAccess': walk(e.object); walk(e.index); break;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
      case 'inExpr': walk(e.element); walk(e.collection); break;
      case 'isExpr': walk(e.value); break;
      case 'listLiteral': e.elements.forEach(walk); break;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
    }
  };
  walk(expr);
  return calls;
}

// ---- Module name sanitization ----

export function sanitizeModuleName(name: string): string {
  return name.replace(/^\.\.\//, '_').replace(/^\.\//, '').replace(/[.\/-]/g, '_');
}

// ---- Expression call rewriting ----

export function rewriteCalls(expr: Expression, renames: Map<string, string>): Expression {
  switch (expr.type) {
    case 'functionCall': {
      const newName = renames.get(expr.name) ?? expr.name;
      const newArgs = expr.args.map(a => rewriteCalls(a, renames));
      return newName === expr.name && newArgs.every((a, i) => a === expr.args[i])
        ? expr : { ...expr, name: newName, args: newArgs };
    }
    case 'binaryOp': {
      const left = rewriteCalls(expr.left, renames);
      const right = rewriteCalls(expr.right, renames);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    case 'unaryOp': {
      const operand = rewriteCalls(expr.operand, renames);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case 'methodCall': {
      const object = rewriteCalls(expr.object, renames);
      const args = expr.args.map(a => rewriteCalls(a, renames));
      return object === expr.object && args.every((a, i) => a === expr.args[i])
        ? expr : { ...expr, object, args };
    }
    case 'memberAccess': {
      const object = rewriteCalls(expr.object, renames);
      return object === expr.object ? expr : { ...expr, object };
    }
    case 'bracketAccess': {
      const object = rewriteCalls(expr.object, renames);
      const index = rewriteCalls(expr.index, renames);
      return object === expr.object && index === expr.index ? expr : { ...expr, object, index };
    }
    case 'ternary': {
      const condition = rewriteCalls(expr.condition, renames);
      const consequent = rewriteCalls(expr.consequent, renames);
      const alternate = rewriteCalls(expr.alternate, renames);
      return condition === expr.condition && consequent === expr.consequent && alternate === expr.alternate
        ? expr : { ...expr, condition, consequent, alternate };
    }
    case 'inExpr': {
      const element = rewriteCalls(expr.element, renames);
      const collection = rewriteCalls(expr.collection, renames);
      return element === expr.element && collection === expr.collection ? expr : { ...expr, element, collection };
    }
    case 'isExpr': {
      const value = rewriteCalls(expr.value, renames);
      return value === expr.value ? expr : { ...expr, value };
    }
    case 'listLiteral': {
      const elements = expr.elements.map(e => rewriteCalls(e, renames));
      return elements.every((e, i) => e === expr.elements[i]) ? expr : { ...expr, elements };
    }
    case 'mapLiteral': {
      const entries = expr.entries.map(en => {
        const key = rewriteCalls(en.key, renames);
        const value = rewriteCalls(en.value, renames);
        return key === en.key && value === en.value ? en : { key, value };
      });
      return entries.every((e, i) => e === expr.entries[i]) ? expr : { ...expr, entries };
    }
    default:
      return expr; // literals, identifiers, pathLiterals — no function calls to rewrite
  }
}

// ---- Private function prefixing ----

export function prefixPrivateFunctions(functions: FunctionDef[], moduleName: string): FunctionDef[] {
  const prefix = sanitizeModuleName(moduleName);
  const renames = new Map<string, string>();

  for (const fn of functions) {
    if (!fn.exported) {
      renames.set(fn.name, `${prefix}__${fn.name}`);
    }
  }

  if (renames.size === 0) return functions;

  return functions.map(fn => {
    const newBody = rewriteCalls(fn.body, renames);
    const newLets = fn.lets.map(binding => {
      const newValue = rewriteCalls(binding.value, renames);
      return newValue === binding.value ? binding : { ...binding, value: newValue };
    });
    const newName = fn.exported ? fn.name : (renames.get(fn.name) ?? fn.name);
    return newBody === fn.body && newLets === fn.lets && newName === fn.name
      ? fn
      : { ...fn, name: newName, body: newBody, lets: newLets };
  });
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
    for (const fn of prefixed) {
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
      if (!exportedFunctions.has(fnName)) {
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

  if (ast.service.name === 'firebase.storage') {
    for (const fn of injected) {
      const requirement = incompatibleStorageFunction(fn);
      if (requirement) {
        return {
          success: false,
          error: {
            code: 'INCOMPATIBLE_FUNCTION',
            message: `Function '${fn.name}' requires unsupported ${requirement} for service 'firebase.storage'`,
          },
        };
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
