import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  FIRESTORE_DIRECT_FUNCTIONS as GENERATED_FIRESTORE_DIRECT_FUNCTIONS,
  FIRESTORE_METHODS as GENERATED_FIRESTORE_METHODS,
  FIRESTORE_METHOD_RECEIVER_TYPES,
  FIRESTORE_NAMESPACE_METHODS,
  STORAGE_BINDING_PATHS,
  STORAGE_METHODS as GENERATED_STORAGE_METHODS,
  STORAGE_METHOD_RECEIVER_TYPES,
  STORAGE_NAMESPACE_METHODS,
} from './rules-capabilities.generated.js';
import {
  STDLIB_SERVICE_CONTRACT_MODULES,
  STDLIB_SERVICE_CONTRACTS,
} from './stdlib-services.generated.js';

export type RulesServiceName = 'cloud.firestore' | 'firebase.storage';

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

export { STDLIB_SERVICE_CONTRACT_MODULES };

// Generated from accepted rules-language inventory rows. An accepted Storage
// row is admitted only after local implementation and production replay.
const FIRESTORE_DIRECT_FUNCTIONS = new Set<string>(GENERATED_FIRESTORE_DIRECT_FUNCTIONS);
const FIRESTORE_METHODS = new Set<string>(GENERATED_FIRESTORE_METHODS);
const FIRESTORE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(FIRESTORE_NAMESPACE_METHODS).map(([namespace, methods]) => [namespace, new Set(methods)]),
);

const STORAGE_METHODS = new Set<string>(GENERATED_STORAGE_METHODS);
const STORAGE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(STORAGE_NAMESPACE_METHODS).map(([namespace, methods]) => [namespace, new Set(methods)]),
);
const STORAGE_BINDINGS = new Set<string>(STORAGE_BINDING_PATHS);
const STORAGE_DYNAMIC_BINDING_PREFIXES = [
  'request.auth.token',
  'request.resource.metadata',
  'resource.metadata',
] as const;

function stdlibContractKey(moduleName: string): string {
  const pathMatch = moduleName.match(/^\.\/stdlib\/(.+?)(?:\.rules)?$/);
  return pathMatch?.[1] ?? moduleName;
}

export function incompatibleStdlibExport(
  service: RulesServiceName,
  moduleName: string,
  functionName: string,
): string | null {
  const contractKey = stdlibContractKey(moduleName);
  const services = STDLIB_SERVICE_CONTRACTS[contractKey as keyof typeof STDLIB_SERVICE_CONTRACTS] as
    readonly RulesServiceName[] | undefined;
  if (!services) return null;
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

function derivedAmbientProvenance(
  expressions: readonly Expression[],
  ctx: AnalysisContext,
): AmbientProvenance {
  return expressions.some((expression) => ambientBindingPath(expression, ctx) !== null)
    ? 'unknown-ambient'
    : null;
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
    // A lookup result is sourced from Firestore, not from the path expression
    // used to address it. Ambient interpolation in that path must still be
    // walked for compatibility, but it does not taint the returned document.
    if (!fn && FIRESTORE_DIRECT_FUNCTIONS.has(expr.name)) return null;
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
      return null;
    case 'methodCall':
      return derivedAmbientProvenance([expr.object, ...expr.args], ctx);
    case 'sliceAccess':
      return derivedAmbientProvenance([expr.object, expr.start, expr.end], ctx);
    case 'binaryOp':
      return derivedAmbientProvenance([expr.left, expr.right], ctx);
    case 'unaryOp':
      return derivedAmbientProvenance([expr.operand], ctx);
    case 'inExpr':
      return derivedAmbientProvenance([expr.element, expr.collection], ctx);
    case 'isExpr':
      return derivedAmbientProvenance([expr.value], ctx);
    case 'listLiteral':
      return derivedAmbientProvenance(expr.elements, ctx);
    case 'mapLiteral':
      return derivedAmbientProvenance(expr.entries.flatMap((entry) => [entry.key, entry.value]), ctx);
    case 'pathLiteral':
      return derivedAmbientProvenance(
        expr.segments.filter((segment): segment is Expression => typeof segment !== 'string'),
        ctx,
      );
    default: return assertNever(expr);
  }
}

function allowedAmbientBinding(service: RulesServiceName, path: readonly string[]): boolean {
  if (path.length === 1) return true;
  if (service === 'firebase.storage') {
    const binding = path.join('.');
    return STORAGE_BINDINGS.has(binding) ||
      STORAGE_DYNAMIC_BINDING_PREFIXES.some((prefix) => binding.startsWith(`${prefix}.`));
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

function ambientCollectionMethodIssue(
  object: Expression,
  method: string,
  args: readonly Expression[],
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  if (method !== 'get' && method !== 'keys' && method !== 'values') return null;
  const objectPath = ambientBindingPath(object, ctx);
  if (objectPath === 'unknown-ambient') return "binding '<derived ambient value>'";
  if (!objectPath) return null;

  if (method === 'get') {
    const key = args[0];
    if (key?.type === 'literal' && typeof key.value === 'string') {
      return provenanceIssue([...objectPath, key.value], service);
    }
    if (!allowsDynamicAmbientAccess(service, objectPath)) {
      return `binding '${objectPath.join('.')}.get(...)'`;
    }
  }

  // keys()/values() disclose an ambient object's complete field surface. That
  // is safe only for bindings whose keys are intentionally user-defined.
  if ((method === 'keys' || method === 'values') &&
      !allowsDynamicAmbientAccess(service, objectPath)) {
    return `binding '${objectPath.join('.')}.${method}()'`;
  }

  return null;
}

type RulesReceiverType =
  | 'bytes'
  | 'duration'
  | 'latlng'
  | 'list'
  | 'map'
  | 'mapdiff'
  | 'number'
  | 'path'
  | 'set'
  | 'string'
  | 'timestamp';

function ambientReceiverType(
  service: RulesServiceName,
  provenance: AmbientProvenance,
): RulesReceiverType | null {
  if (!provenance || provenance === 'unknown-ambient') return null;
  const path = provenance.join('.');
  if (path === 'request.auth' || path === 'request.auth.token' ||
      path === 'request.resource' || path === 'resource' ||
      path === 'request.resource.data' || path === 'resource.data' ||
      path === 'request.query' || path === 'request.resource.metadata' ||
      path === 'resource.metadata') return 'map';
  if (path === 'request.auth.uid' || path === 'request.method' ||
      path === 'request.resource.contentType' || path === 'resource.contentType' ||
      service === 'firebase.storage' &&
        (path.startsWith('request.resource.metadata.') || path.startsWith('resource.metadata.'))) {
    return 'string';
  }
  if (path === 'request.path') return 'path';
  if (path === 'request.time' || path === 'resource.timeCreated' || path === 'resource.updated') {
    return 'timestamp';
  }
  if (['request.resource.size', 'resource.size', 'resource.generation', 'resource.metageneration']
    .includes(path)) return 'number';
  return null;
}

function ambientMethodReturnType(expression: Expression): RulesReceiverType | null {
  if (expression.type !== 'methodCall') return null;
  if (['lower', 'upper', 'trim', 'replace', 'join', 'toBase64', 'toHexString']
    .includes(expression.method)) return 'string';
  if (['concat', 'removeAll', 'split', 'values'].includes(expression.method)) return 'list';
  if (['keys', 'toSet', 'addedKeys', 'removedKeys', 'changedKeys', 'affectedKeys',
    'unchangedKeys', 'difference', 'union', 'intersection'].includes(expression.method)) return 'set';
  if (expression.method === 'diff') return 'mapdiff';
  if (expression.method === 'toUtf8') return 'bytes';
  if (expression.method === 'date') return 'timestamp';
  if (['size', 'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'nanos',
    'dayOfWeek', 'dayOfYear', 'toMillis', 'latitude', 'longitude', 'distance']
    .includes(expression.method)) return 'number';
  return null;
}

function ambientMethodReceiverIssue(
  object: Expression,
  method: string,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const provenance = ambientBindingPath(object, ctx);
  const receiverType = ambientReceiverType(service, provenance) ?? ambientMethodReturnType(object);
  if (!receiverType) {
    return provenance === 'unknown-ambient' ? "binding '<derived ambient receiver>'" : null;
  }
  const contracts = service === 'cloud.firestore'
    ? FIRESTORE_METHOD_RECEIVER_TYPES
    : STORAGE_METHOD_RECEIVER_TYPES;
  const allowed = contracts[method as keyof typeof contracts] as readonly string[] | undefined;
  return allowed?.includes(receiverType)
    ? null
    : `method '.${method}()' requires ${allowed?.join('|') ?? 'an accepted'} receiver, got ${receiverType}`;
}

function ambientMembershipIssue(
  element: Expression,
  collection: Expression,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const collectionPath = ambientBindingPath(collection, ctx);
  if (collectionPath === 'unknown-ambient') return "binding '<derived ambient value>'";
  if (!collectionPath) return null;
  if (element.type === 'literal' && typeof element.value === 'string') {
    return provenanceIssue([...collectionPath, element.value], service);
  }
  return allowsDynamicAmbientAccess(service, collectionPath)
    ? null
    : `binding '<value> in ${collectionPath.join('.')}'`;
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
          return `namespace '${e.object.name}'`;
        }
        const methods = service === 'cloud.firestore' ? FIRESTORE_METHODS : STORAGE_METHODS;
        if (!methods.has(e.method)) return `method '.${e.method}()'`;
        const receiverIssue = ambientMethodReceiverIssue(e.object, e.method, service, ctx);
        if (receiverIssue) return receiverIssue;
        const ambientIssue = ambientCollectionMethodIssue(e.object, e.method, e.args, service, ctx);
        if (ambientIssue) return ambientIssue;
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
      case 'inExpr':
        return ambientMembershipIssue(e.element, e.collection, service, ctx) ??
          walk(e.element) ?? walk(e.collection);
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
