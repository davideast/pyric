import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  FIRESTORE_DIRECT_FUNCTIONS as GENERATED_FIRESTORE_DIRECT_FUNCTIONS,
  FIRESTORE_METHODS as GENERATED_FIRESTORE_METHODS,
  FIRESTORE_NAMESPACE_METHODS,
} from './firestore-capabilities.generated.js';

export type RulesServiceName = 'cloud.firestore' | 'firebase.storage';

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

interface ModuleContract {
  defaultServices: readonly RulesServiceName[];
  exports?: Readonly<Record<string, readonly RulesServiceName[]>>;
}

const FIRESTORE_ONLY: readonly RulesServiceName[] = ['cloud.firestore'];
const STORAGE_ONLY: readonly RulesServiceName[] = ['firebase.storage'];
const FIRESTORE_AND_STORAGE: readonly RulesServiceName[] = ['cloud.firestore', 'firebase.storage'];

/**
 * Reviewed service contracts for bundled modules. A module is never admitted
 * to a second service merely because its source parses there.
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
  'storage/uploads': { defaultServices: STORAGE_ONLY },
  'storage/metadata': { defaultServices: STORAGE_ONLY },
  'storage/objects': { defaultServices: STORAGE_ONLY },
  'storage/time': { defaultServices: STORAGE_ONLY },
};

export const STDLIB_SERVICE_CONTRACT_MODULES = Object.freeze(
  Object.keys(STDLIB_MODULE_CONTRACTS).sort(),
);

// Generated from accepted rules-language inventory rows. Storage stays
// deliberately narrower: only its locally implemented, observed subset is admitted.
const FIRESTORE_DIRECT_FUNCTIONS = new Set<string>(GENERATED_FIRESTORE_DIRECT_FUNCTIONS);
const FIRESTORE_METHODS = new Set<string>(GENERATED_FIRESTORE_METHODS);
const FIRESTORE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(FIRESTORE_NAMESPACE_METHODS).map(([namespace, methods]) => [namespace, new Set(methods)]),
);

const STORAGE_METHODS = new Set(['get', 'hasAll', 'keys', 'matches', 'size', 'split']);
const STORAGE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = {
  duration: new Set(['value']),
  firestore: new Set(['exists', 'get']),
  timestamp: new Set(['date', 'value']),
};

function stdlibContractKey(moduleName: string): string {
  const pathMatch = moduleName.match(/^\.\/stdlib\/(.+?)(?:\.rules)?$/);
  return pathMatch?.[1] ?? moduleName;
}

export function incompatibleStdlibExport(
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

type AmbientProvenance = string[] | 'unknown-ambient' | null;

interface AnalysisContext {
  aliases: ReadonlyMap<string, AmbientProvenance>;
  functions: ReadonlyMap<string, FunctionDef>;
  stack: ReadonlySet<string>;
}

function ambientBindingPath(expr: Expression, ctx: AnalysisContext): AmbientProvenance {
  if (expr.type === 'identifier') {
    if (expr.name === 'request' || expr.name === 'resource') return [expr.name];
    return ctx.aliases.get(expr.name) ?? null;
  }
  if (expr.type === 'memberAccess') {
    const parent = ambientBindingPath(expr.object, ctx);
    if (parent === 'unknown-ambient') return parent;
    return parent ? [...parent, expr.property] : null;
  }
  if (expr.type === 'bracketAccess') {
    const parent = ambientBindingPath(expr.object, ctx);
    if (!parent || parent === 'unknown-ambient') return parent;
    return expr.index.type === 'literal' && typeof expr.index.value === 'string'
      ? [...parent, expr.index.value]
      : [...parent, '*'];
  }
  if (expr.type === 'ternary') {
    const consequent = ambientBindingPath(expr.consequent, ctx);
    const alternate = ambientBindingPath(expr.alternate, ctx);
    if (!consequent && !alternate) return null;
    if (Array.isArray(consequent) && Array.isArray(alternate) &&
      consequent.join('.') === alternate.join('.')) return consequent;
    return 'unknown-ambient';
  }
  if (expr.type === 'functionCall') {
    const fn = ctx.functions.get(expr.name);
    const args = expr.args.map((arg) => ambientBindingPath(arg, ctx));
    if (!fn || ctx.stack.has(fn.name)) {
      return args.some((arg) => arg !== null) ? 'unknown-ambient' : null;
    }
    const aliases = new Map<string, AmbientProvenance>();
    fn.parameters.forEach((parameter, index) => aliases.set(parameter, args[index] ?? null));
    const nested: AnalysisContext = {
      aliases,
      functions: ctx.functions,
      stack: new Set([...ctx.stack, fn.name]),
    };
    for (const binding of fn.lets) {
      aliases.set(binding.name, ambientBindingPath(binding.value, nested));
    }
    return ambientBindingPath(fn.body, nested);
  }
  switch (expr.type) {
    case 'literal':
    case 'methodCall':
    case 'sliceAccess':
    case 'binaryOp':
    case 'unaryOp':
    case 'inExpr':
    case 'isExpr':
    case 'listLiteral':
    case 'mapLiteral':
    case 'pathLiteral': return null;
    default: return assertNever(expr);
  }
}

function allowedAmbientBinding(service: RulesServiceName, path: readonly string[]): boolean {
  if (path.length === 1) return true;
  if (service === 'firebase.storage') {
    if (path[0] === 'request') {
      if (path[1] === 'auth') return true;
      if (['time', 'method', 'path'].includes(path[1]!)) return path.length === 2;
      if (path[1] !== 'resource') return false;
      if (path.length === 2) return true;
      if (path[2] === 'metadata') return true;
      return path.length === 3 && ['size', 'contentType', 'name'].includes(path[2]!);
    }
    if (path[0] === 'resource') {
      if (path[1] === 'metadata') return true;
      return path.length === 2 && [
        'name', 'bucket', 'size', 'contentType', 'timeCreated', 'updated',
        'generation', 'metageneration', 'md5Hash', 'crc32c', 'etag',
      ].includes(path[1]!);
    }
    return false;
  }
  if (path[0] === 'request') {
    if (path[1] === 'auth' || path[1] === 'query') return true;
    if (['time', 'method', 'path'].includes(path[1]!)) return path.length === 2;
    return path[1] === 'resource' && (path.length === 2 || path[2] === 'data');
  }
  return path[0] === 'resource' && (path.length === 1 || path[1] === 'data');
}

function allowsDynamicAmbientAccess(service: RulesServiceName, path: readonly string[]): boolean {
  if (path[0] === 'request' && path[1] === 'auth' && path[2] === 'token') return true;
  if (service === 'firebase.storage') {
    return path[0] === 'resource' && path[1] === 'metadata' ||
      path[0] === 'request' && path[1] === 'resource' && path[2] === 'metadata';
  }
  return path[0] === 'resource' && path[1] === 'data' ||
    path[0] === 'request' && path[1] === 'resource' && path[2] === 'data' ||
    path[0] === 'request' && path[1] === 'query';
}

function provenanceIssue(
  provenance: AmbientProvenance,
  service: RulesServiceName,
): string | null {
  if (provenance === 'unknown-ambient') return "binding '<derived ambient value>'";
  return provenance && !allowedAmbientBinding(service, provenance)
    ? `binding '${provenance.join('.')}'`
    : null;
}

function serviceIncompatibility(
  expr: Expression,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const walk = (e: Expression): string | null => {
    switch (e.type) {
      case 'memberAccess': {
        const issue = provenanceIssue(ambientBindingPath(e, ctx), service);
        if (issue) return issue;
        return walk(e.object);
      }
      case 'functionCall': {
        const called = ctx.functions.get(e.name);
        if (!called && service === 'firebase.storage') {
          return `function '${e.name}()'`;
        }
        if (!called && !FIRESTORE_DIRECT_FUNCTIONS.has(e.name)) return `function '${e.name}()'`;
        for (const arg of e.args) {
          const issue = walk(arg);
          if (issue) return issue;
        }
        if (called && !ctx.stack.has(called.name)) {
          const aliases = new Map<string, AmbientProvenance>();
          called.parameters.forEach((parameter, index) => {
            aliases.set(parameter, e.args[index] ? ambientBindingPath(e.args[index]!, ctx) : null);
          });
          const issue = functionIncompatibility(called, service, {
            aliases,
            functions: ctx.functions,
            stack: new Set([...ctx.stack, called.name]),
          });
          if (issue) return issue;
        }
        return null;
      }
      case 'methodCall': {
        if (e.object.type === 'identifier' && !ctx.aliases.has(e.object.name)) {
          const namespaces = service === 'cloud.firestore' ? FIRESTORE_NAMESPACES : STORAGE_NAMESPACES;
          const methods = namespaces[e.object.name];
          if (methods) {
            if (!methods.has(e.method)) return `method '${e.object.name}.${e.method}()'`;
            for (const arg of e.args) {
              const issue = walk(arg);
              if (issue) return issue;
            }
            return null;
          }
          if (e.object.name === 'firestore') return `method 'firestore.${e.method}()'`;
        }
        const methods = service === 'cloud.firestore' ? FIRESTORE_METHODS : STORAGE_METHODS;
        if (!methods.has(e.method)) return `method '.${e.method}()'`;
        return walk(e.object) ?? e.args.map(walk).find(Boolean) ?? null;
      }
      case 'binaryOp': return walk(e.left) ?? walk(e.right);
      case 'unaryOp': return walk(e.operand);
      case 'bracketAccess': {
        const objectPath = ambientBindingPath(e.object, ctx);
        if (objectPath === 'unknown-ambient') return "binding '<derived ambient value>[...]'";
        const literalKey = e.index.type === 'literal' && typeof e.index.value === 'string';
        if (objectPath && !literalKey) {
          if (!allowsDynamicAmbientAccess(service, objectPath)) {
            return `binding '${objectPath.join('.')}[...]'`;
          }
          return walk(e.object) ?? walk(e.index);
        }
        const fullIssue = provenanceIssue(ambientBindingPath(e, ctx), service);
        if (fullIssue) return fullIssue;
        return walk(e.object) ?? walk(e.index);
      }
      case 'sliceAccess': return walk(e.object) ?? walk(e.start) ?? walk(e.end);
      case 'ternary': return walk(e.condition) ?? walk(e.consequent) ?? walk(e.alternate);
      case 'inExpr': return walk(e.element) ?? walk(e.collection);
      case 'isExpr': return walk(e.value);
      case 'listLiteral': return e.elements.map(walk).find(Boolean) ?? null;
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
      case 'literal':
      case 'identifier': return null;
      default: return assertNever(e);
    }
  };
  return walk(expr);
}

function functionIncompatibility(
  fn: FunctionDef,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const aliases = new Map(ctx.aliases);
  const localCtx = { ...ctx, aliases };
  for (const binding of fn.lets) {
    const issue = serviceIncompatibility(binding.value, service, localCtx);
    if (issue) return issue;
    aliases.set(binding.name, ambientBindingPath(binding.value, localCtx));
  }
  return serviceIncompatibility(fn.body, service, localCtx);
}

export function incompatibleFunction(
  fn: FunctionDef,
  service: RulesServiceName,
  functions: ReadonlyMap<string, FunctionDef> = new Map([[fn.name, fn]]),
): string | null {
  return functionIncompatibility(fn, service, {
    aliases: new Map(fn.parameters.map((parameter) => [parameter, null])),
    functions,
    stack: new Set([fn.name]),
  });
}
