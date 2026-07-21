import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';

export type RulesServiceName = 'cloud.firestore' | 'firebase.storage';

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

// Complete Firestore method/namespace vocabulary pinned by the repository's
// rules-language inventory. Storage stays deliberately narrower: only its
// locally implemented, production-observed subset is admitted.
const FIRESTORE_METHODS = new Set([
  'abs', 'addedKeys', 'affectedKeys', 'changedKeys', 'concat', 'date', 'day',
  'dayOfWeek', 'dayOfYear', 'difference', 'diff', 'distance', 'get', 'hasAll',
  'hasAny', 'hasOnly', 'hours', 'intersection', 'join', 'keys', 'latitude',
  'longitude', 'lower', 'matches', 'minutes', 'month', 'nanos', 'removeAll',
  'removedKeys', 'replace', 'seconds', 'size', 'split', 'time', 'toBase64',
  'toHexString', 'toMillis', 'toSet', 'toUtf8', 'trim', 'unchangedKeys',
  'union', 'upper', 'values', 'year',
]);

const FIRESTORE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = {
  cast: new Set(['bool', 'float', 'int', 'path', 'string']),
  duration: new Set(['abs', 'time', 'value']),
  hashing: new Set(['crc32', 'crc32c', 'md5', 'sha256']),
  latlng: new Set(['value']),
  math: new Set(['abs', 'ceil', 'floor', 'isInfinite', 'isNaN', 'pow', 'round', 'sqrt']),
  timestamp: new Set(['date', 'value']),
};

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

function ambientBindingPath(expr: Expression): string[] | null {
  if (expr.type === 'identifier') {
    return expr.name === 'request' || expr.name === 'resource' ? [expr.name] : null;
  }
  if (expr.type === 'memberAccess') {
    const parent = ambientBindingPath(expr.object);
    return parent ? [...parent, expr.property] : null;
  }
  if (expr.type === 'bracketAccess' && expr.index.type === 'literal' && typeof expr.index.value === 'string') {
    const parent = ambientBindingPath(expr.object);
    return parent ? [...parent, expr.index.value] : null;
  }
  return null;
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

function serviceIncompatibility(expr: Expression, service: RulesServiceName): string | null {
  const walk = (e: Expression): string | null => {
    switch (e.type) {
      case 'memberAccess': {
        const path = ambientBindingPath(e);
        if (path && !allowedAmbientBinding(service, path)) return `binding '${path.join('.')}'`;
        return walk(e.object);
      }
      case 'functionCall': {
        if (service === 'firebase.storage' && ['get', 'exists', 'getAfter', 'existsAfter', 'debug'].includes(e.name)) {
          return `function '${e.name}()'`;
        }
        for (const arg of e.args) {
          const issue = walk(arg);
          if (issue) return issue;
        }
        return null;
      }
      case 'methodCall': {
        if (e.object.type === 'identifier') {
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
        const fullPath = ambientBindingPath(e);
        if (fullPath && !allowedAmbientBinding(service, fullPath)) return `binding '${fullPath.join('.')}'`;
        const objectPath = ambientBindingPath(e.object);
        if (objectPath && e.index.type !== 'literal' && !allowsDynamicAmbientAccess(service, objectPath)) {
          return `binding '${objectPath.join('.')}[...]'`;
        }
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
      default: return null;
    }
  };
  return walk(expr);
}

export function incompatibleFunction(fn: FunctionDef, service: RulesServiceName): string | null {
  for (const binding of fn.lets) {
    const issue = serviceIncompatibility(binding.value, service);
    if (issue) return issue;
  }
  return serviceIncompatibility(fn.body, service);
}
