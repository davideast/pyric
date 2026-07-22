import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  FIRESTORE_DIRECT_FUNCTIONS as GENERATED_FIRESTORE_DIRECT_FUNCTIONS,
  FIRESTORE_METHODS as GENERATED_FIRESTORE_METHODS,
  FIRESTORE_METHOD_RECEIVER_TYPES,
  FIRESTORE_NAMESPACE_METHODS,
  STORAGE_METHODS as GENERATED_STORAGE_METHODS,
  STORAGE_METHOD_RECEIVER_TYPES,
  STORAGE_NAMESPACE_METHODS,
} from './rules-capabilities.generated.js';
import {
  type RulesServiceName,
  incompatibleStdlibExport,
} from './stdlib-service-compatibility.js';
import {
  allowedAmbientBinding,
  allowsDynamicAmbientAccess,
} from './service-bindings.js';
import {
  ambientReceiverType,
  methodReturnType,
  type RulesReceiverType,
} from './receiver-types.js';
export {
  STDLIB_SERVICE_CONTRACT_MODULES,
  incompatibleStdlibExport,
} from './stdlib-service-compatibility.js';
export type { RulesServiceName } from './stdlib-service-compatibility.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

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
type AmbientProvenance = string[] | 'unknown-ambient' | null;
type InferredReceiverType = RulesReceiverType | 'mixed';

interface AnalysisContext {
  aliases: ReadonlyMap<string, AmbientProvenance>;
  receiverTypes: ReadonlyMap<string, InferredReceiverType | null>;
  functions: ReadonlyMap<string, FunctionDef>;
  service: RulesServiceName;
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
    const receiverTypes = new Map(fn.parameters.map((parameter, index) => [
      parameter,
      expr.args[index] ? expressionReceiverType(expr.args[index]!, ctx) : null,
    ]));
    const nested: AnalysisContext = {
      aliases,
      receiverTypes,
      functions: ctx.functions,
      service: ctx.service,
      stack: new Set([...ctx.stack, fn.name]),
    };
    for (const binding of fn.lets) {
      aliases.set(binding.name, ambientBindingPath(binding.value, nested));
      receiverTypes.set(binding.name, expressionReceiverType(binding.value, nested));
    }
    return ambientBindingPath(fn.body, nested);
  }
  if (expr.type === 'methodCall' && expr.object.type === 'identifier' &&
      expr.object.name === 'firestore' && (expr.method === 'get' || expr.method === 'exists')) {
    // The lookup address may contain ambient interpolation, but the result is
    // Firestore-sourced. serviceIncompatibility still walks every path arg.
    return null;
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

function expressionReceiverType(
  expression: Expression,
  ctx: AnalysisContext,
): InferredReceiverType | null {
  const ambientType = ambientReceiverType(ctx.service, ambientBindingPath(expression, ctx));
  if (ambientType) return ambientType;
  switch (expression.type) {
    case 'identifier': {
      const inferred = ctx.receiverTypes.get(expression.name);
      if (inferred) return inferred;
      const namespaces = ctx.service === 'cloud.firestore' ? FIRESTORE_NAMESPACES : STORAGE_NAMESPACES;
      return namespaces[expression.name] || expression.name === 'firestore' ? 'namespace' : null;
    }
    case 'literal':
      if (expression.value === null) return 'null';
      if (typeof expression.value === 'string') return 'string';
      if (typeof expression.value === 'number') return 'number';
      if (typeof expression.value === 'boolean') return 'boolean';
      return null;
    case 'listLiteral': return 'list';
    case 'mapLiteral': return 'map';
    case 'pathLiteral': return 'path';
    case 'memberAccess': {
      const objectType = expressionReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      if (expression.property === 'data' &&
          objectType === 'document') return 'map';
      if (expression.object.type === 'mapLiteral') {
        const entry = expression.object.entries.find(({ key }) =>
          key.type === 'literal' && key.value === expression.property);
        return entry ? expressionReceiverType(entry.value, ctx) : null;
      }
      return null;
    }
    case 'bracketAccess': {
      const objectType = expressionReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      if (expression.object.type === 'listLiteral' && expression.index.type === 'literal' &&
          typeof expression.index.value === 'number' && Number.isInteger(expression.index.value)) {
        const element = expression.object.elements[expression.index.value];
        return element ? expressionReceiverType(element, ctx) : null;
      }
      if (expression.object.type === 'mapLiteral' && expression.index.type === 'literal') {
        const indexValue = expression.index.value;
        const entry = expression.object.entries.find(({ key }) =>
          key.type === 'literal' && key.value === indexValue);
        return entry ? expressionReceiverType(entry.value, ctx) : null;
      }
      if (objectType === 'string') return 'string';
      const objectPath = ambientBindingPath(expression.object, ctx);
      if (ctx.service === 'firebase.storage' && Array.isArray(objectPath) &&
          (objectPath.join('.') === 'request.resource.metadata' ||
           objectPath.join('.') === 'resource.metadata')) return 'string';
      return null;
    }
    case 'sliceAccess': {
      const objectType = expressionReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      return objectType === 'list' || objectType === 'string' ? objectType : null;
    }
    case 'methodCall': {
      const namespaceReturnType = methodReturnType(expression);
      if (expression.object.type === 'identifier' && namespaceReturnType) {
        return namespaceReturnType;
      }
      if (expression.method === 'get') {
        const objectPath = ambientBindingPath(expression.object, ctx);
        if (ctx.service === 'firebase.storage' && Array.isArray(objectPath) &&
            (objectPath.join('.') === 'request.resource.metadata' ||
             objectPath.join('.') === 'resource.metadata')) return 'string';
        const fallback = expression.args[1];
        if (expression.object.type === 'mapLiteral' && expression.args[0]?.type === 'literal') {
          const keyValue = expression.args[0].value;
          const entry = expression.object.entries.find(({ key }) =>
            key.type === 'literal' && key.value === keyValue);
          if (entry) return expressionReceiverType(entry.value, ctx);
          return fallback ? expressionReceiverType(fallback, ctx) : null;
        }
        return fallback && expressionReceiverType(fallback, ctx) ? 'mixed' : null;
      }
      return methodReturnType(expression);
    }
    case 'binaryOp': {
      const left = expressionReceiverType(expression.left, ctx);
      const right = expressionReceiverType(expression.right, ctx);
      if (expression.op === '+' && (left === 'string' || right === 'string')) return 'string';
      if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expression.op)) return 'boolean';
      return ['+', '-', '*', '/', '%'].includes(expression.op) && left === 'number' && right === 'number'
        ? 'number' : null;
    }
    case 'unaryOp':
      if (expression.op === '!') return 'boolean';
      return expression.op === '-' && expressionReceiverType(expression.operand, ctx) === 'number'
        ? 'number' : null;
    case 'inExpr':
    case 'isExpr': return 'boolean';
    case 'ternary': {
      const consequent = expressionReceiverType(expression.consequent, ctx);
      const alternate = expressionReceiverType(expression.alternate, ctx);
      if (!consequent && !alternate) return null;
      return consequent === alternate ? consequent : 'mixed';
    }
    case 'functionCall': {
      const fn = ctx.functions.get(expression.name);
      if (!fn && ctx.service === 'cloud.firestore') {
        if (expression.name === 'get' || expression.name === 'getAfter') return 'document';
        if (expression.name === 'exists') return 'boolean';
      }
      if (!fn || ctx.stack.has(fn.name)) return null;
      const aliases = new Map<string, AmbientProvenance>();
      const receiverTypes = new Map<string, InferredReceiverType | null>();
      fn.parameters.forEach((parameter, index) => {
        const arg = expression.args[index];
        aliases.set(parameter, arg ? ambientBindingPath(arg, ctx) : null);
        receiverTypes.set(parameter, arg ? expressionReceiverType(arg, ctx) : null);
      });
      const nested: AnalysisContext = {
        aliases,
        receiverTypes,
        functions: ctx.functions,
        service: ctx.service,
        stack: new Set([...ctx.stack, fn.name]),
      };
      for (const binding of fn.lets) {
        aliases.set(binding.name, ambientBindingPath(binding.value, nested));
        receiverTypes.set(binding.name, expressionReceiverType(binding.value, nested));
      }
      return expressionReceiverType(fn.body, nested);
    }
    default: return null;
  }
}

function ambientMethodReceiverIssue(
  object: Expression,
  method: string,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const provenance = ambientBindingPath(object, ctx);
  const receiverType = expressionReceiverType(object, ctx);
  if (!receiverType) {
    if (provenance === 'unknown-ambient') return "binding '<derived ambient receiver>'";
    let projectionSource: Expression = object;
    while (projectionSource.type === 'memberAccess' || projectionSource.type === 'bracketAccess' ||
      projectionSource.type === 'methodCall' && projectionSource.method === 'get') {
      projectionSource = projectionSource.object;
    }
    const projectedType = expressionReceiverType(projectionSource, ctx);
    if (projectedType === 'map' || projectedType === 'list' || projectedType === 'document') {
      return `method '.${method}()' has an unresolved projected receiver`;
    }
    return null;
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
          const receiverTypes = new Map<string, InferredReceiverType | null>();
          called.parameters.forEach((parameter, index) => {
            const arg = e.args[index];
            aliases.set(parameter, arg ? ambientBindingPath(arg, ctx) : null);
            receiverTypes.set(parameter, arg ? expressionReceiverType(arg, ctx) : null);
          });
          const issue = functionIncompatibility(called, service, {
            aliases,
            receiverTypes,
            functions: ctx.functions,
            service,
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
      case 'literal': return null;
      case 'identifier':
        if (e.name === 'request' || e.name === 'resource' || ctx.aliases.has(e.name)) {
          return null;
        }
        return `identifier '${e.name}'`;
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
  const receiverTypes = new Map(ctx.receiverTypes);
  const localCtx = { ...ctx, aliases, receiverTypes };
  for (const binding of fn.lets) {
    const issue = serviceIncompatibility(binding.value, service, localCtx);
    if (issue) return issue;
    aliases.set(binding.name, ambientBindingPath(binding.value, localCtx));
    receiverTypes.set(binding.name, expressionReceiverType(binding.value, localCtx));
  }
  return serviceIncompatibility(fn.body, service, localCtx);
}

export function incompatibleFunction(
  fn: FunctionDef,
  service: RulesServiceName,
  functions: ReadonlyMap<string, FunctionDef> = new Map([[fn.name, fn]]),
  args: readonly Expression[] = [],
  argReceiverTypes: readonly (RulesReceiverType | null)[] = [],
  argProvenances: readonly AmbientProvenance[] = [],
): string | null {
  const rootCtx: AnalysisContext = {
    aliases: new Map(),
    receiverTypes: new Map(),
    functions,
    service,
    stack: new Set([fn.name]),
  };
  return functionIncompatibility(fn, service, {
    aliases: new Map(fn.parameters.map((parameter, index) => [
      parameter,
      index < argProvenances.length
        ? argProvenances[index] ?? null
        : args[index] ? ambientBindingPath(args[index]!, rootCtx) : null,
    ])),
    receiverTypes: new Map(fn.parameters.map((parameter, index) => [
      parameter,
      args[index]
        ? expressionReceiverType(args[index]!, rootCtx) ?? argReceiverTypes[index] ?? null
        : null,
    ])),
    functions,
    service,
    stack: new Set([fn.name]),
  });
}
