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
  sourceProvenance,
  sourceReceiverType,
  type InferredReceiverType,
  type SourceExpressionContext,
  type SourceExpressionFacts,
  type SourceProvenance,
} from './source-expression-analysis.js';
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
type AmbientProvenance = SourceProvenance;
type AnalysisContext = SourceExpressionContext;

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
  const objectPath = sourceProvenance(object, ctx);
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

function ambientMethodReceiverIssue(
  object: Expression,
  method: string,
  service: RulesServiceName,
  ctx: AnalysisContext,
): string | null {
  const provenance = sourceProvenance(object, ctx);
  const receiverType = sourceReceiverType(object, ctx);
  if (!receiverType) {
    if (provenance === 'unknown-ambient') return "binding '<derived ambient receiver>'";
    let projectionSource: Expression = object;
    while (projectionSource.type === 'memberAccess' || projectionSource.type === 'bracketAccess' ||
      projectionSource.type === 'methodCall' && projectionSource.method === 'get') {
      projectionSource = projectionSource.object;
    }
    const projectedType = sourceReceiverType(projectionSource, ctx);
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
  const collectionPath = sourceProvenance(collection, ctx);
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
        const issue = provenanceIssue(sourceProvenance(e, ctx), service);
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
            aliases.set(parameter, arg ? sourceProvenance(arg, ctx) : null);
            receiverTypes.set(parameter, arg ? sourceReceiverType(arg, ctx) : null);
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
        const objectPath = sourceProvenance(e.object, ctx);
        if (objectPath === 'unknown-ambient') return "binding '<derived ambient value>[...]'";
        const literalKey = e.index.type === 'literal' && typeof e.index.value === 'string';
        if (objectPath && !literalKey) {
          if (!allowsDynamicAmbientAccess(service, objectPath)) {
            return `binding '${objectPath.join('.')}[...]'`;
          }
          return walk(e.object) ?? walk(e.index);
        }
        const fullIssue = provenanceIssue(sourceProvenance(e, ctx), service);
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
    aliases.set(binding.name, sourceProvenance(binding.value, localCtx));
    receiverTypes.set(binding.name, sourceReceiverType(binding.value, localCtx));
  }
  return serviceIncompatibility(fn.body, service, localCtx);
}

export function incompatibleFunction(
  fn: FunctionDef,
  service: RulesServiceName,
  functions: ReadonlyMap<string, FunctionDef> = new Map([[fn.name, fn]]),
  arguments_: readonly SourceExpressionFacts[] = [],
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
      index < arguments_.length
        ? arguments_[index]?.provenance ?? null
        : null,
    ])),
    receiverTypes: new Map(fn.parameters.map((parameter, index) => [
      parameter,
      arguments_[index]
        ? sourceReceiverType(arguments_[index].expression, rootCtx) ??
          arguments_[index].receiverType ?? null
        : null,
    ])),
    functions,
    service,
    stack: new Set([fn.name]),
  });
}
