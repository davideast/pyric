import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import {
  FIRESTORE_DIRECT_FUNCTIONS as GENERATED_FIRESTORE_DIRECT_FUNCTIONS,
  FIRESTORE_NAMESPACE_METHODS,
  STORAGE_NAMESPACE_METHODS,
} from './rules-capabilities.generated.js';
import { ambientReceiverType, methodReturnType, type RulesReceiverType } from './receiver-types.js';
import type { RulesServiceName } from './stdlib-service-compatibility.js';

export type SourceProvenance = string[] | 'unknown-ambient' | null;
export type InferredReceiverType = RulesReceiverType | 'mixed';

export interface SourceExpressionFacts {
  expression: Expression;
  provenance: SourceProvenance;
  receiverType: InferredReceiverType | null;
}

export interface SourceFunctionDeclaration {
  aliases: ReadonlyMap<string, SourceProvenance>;
  receiverTypes: ReadonlyMap<string, InferredReceiverType | null>;
  functions: ReadonlyMap<string, FunctionDef>;
}

export interface SourceExpressionContext {
  aliases: Map<string, SourceProvenance>;
  receiverTypes: Map<string, InferredReceiverType | null>;
  functions: ReadonlyMap<string, FunctionDef>;
  service: RulesServiceName;
  stack: ReadonlySet<string>;
  declarations?: ReadonlyMap<FunctionDef, SourceFunctionDeclaration>;
}

const FIRESTORE_DIRECT_FUNCTIONS = new Set<string>(GENERATED_FIRESTORE_DIRECT_FUNCTIONS);
const FIRESTORE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(FIRESTORE_NAMESPACE_METHODS).map(([namespace, methods]) => [namespace, new Set(methods)]),
);
const STORAGE_NAMESPACES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(STORAGE_NAMESPACE_METHODS).map(([namespace, methods]) => [namespace, new Set(methods)]),
);

function derivedProvenance(
  expressions: readonly Expression[],
  ctx: SourceExpressionContext,
): SourceProvenance {
  return expressions.some((expression) => sourceProvenance(expression, ctx) !== null)
    ? 'unknown-ambient'
    : null;
}

function functionContext(
  fn: FunctionDef,
  arguments_: readonly SourceExpressionFacts[],
  ctx: SourceExpressionContext,
): SourceExpressionContext {
  const declaration = ctx.declarations?.get(fn);
  const aliases = new Map(declaration?.aliases);
  const receiverTypes = new Map(declaration?.receiverTypes);
  fn.parameters.forEach((parameter, index) => {
    aliases.set(parameter, arguments_[index]?.provenance ?? null);
    receiverTypes.set(parameter, arguments_[index]?.receiverType ?? null);
  });
  return {
    aliases,
    receiverTypes,
    functions: declaration?.functions ?? ctx.functions,
    service: ctx.service,
    stack: new Set([...ctx.stack, fn.name]),
    declarations: ctx.declarations,
  };
}

export function expressionFacts(
  expression: Expression,
  ctx: SourceExpressionContext,
): SourceExpressionFacts {
  return {
    expression,
    provenance: sourceProvenance(expression, ctx),
    receiverType: sourceReceiverType(expression, ctx),
  };
}

export function sourceProvenance(
  expression: Expression,
  ctx: SourceExpressionContext,
): SourceProvenance {
  if (expression.type === 'identifier') {
    if (expression.name === 'request' || expression.name === 'resource') return [expression.name];
    return ctx.aliases.get(expression.name) ?? null;
  }
  if (expression.type === 'memberAccess') {
    const parent = sourceProvenance(expression.object, ctx);
    if (parent === 'unknown-ambient') return parent;
    return parent ? [...parent, expression.property] : null;
  }
  if (expression.type === 'bracketAccess') {
    const parent = sourceProvenance(expression.object, ctx);
    if (!parent || parent === 'unknown-ambient') return parent;
    return expression.index.type === 'literal' && typeof expression.index.value === 'string'
      ? [...parent, expression.index.value]
      : [...parent, '*'];
  }
  if (expression.type === 'ternary') {
    const consequent = sourceProvenance(expression.consequent, ctx);
    const alternate = sourceProvenance(expression.alternate, ctx);
    if (!consequent && !alternate) return null;
    if (Array.isArray(consequent) && Array.isArray(alternate) &&
        consequent.join('.') === alternate.join('.')) return consequent;
    return 'unknown-ambient';
  }
  if (expression.type === 'functionCall') {
    const fn = ctx.functions.get(expression.name);
    const arguments_ = expression.args.map((argument) => expressionFacts(argument, ctx));
    // Lookup results are Firestore-sourced; ambient path interpolation is
    // still walked by compatibility validation but does not taint the result.
    if (!fn && FIRESTORE_DIRECT_FUNCTIONS.has(expression.name)) return null;
    if (!fn || ctx.stack.has(fn.name)) {
      return arguments_.some(({ provenance }) => provenance !== null)
        ? 'unknown-ambient'
        : null;
    }
    const nested = functionContext(fn, arguments_, ctx);
    for (const binding of fn.lets) {
      const facts = expressionFacts(binding.value, nested);
      nested.aliases.set(binding.name, facts.provenance);
      nested.receiverTypes.set(binding.name, facts.receiverType);
    }
    return sourceProvenance(fn.body, nested);
  }
  if (expression.type === 'methodCall' && expression.object.type === 'identifier' &&
      expression.object.name === 'firestore' &&
      (expression.method === 'get' || expression.method === 'exists')) return null;

  switch (expression.type) {
    case 'literal': return null;
    case 'methodCall': return derivedProvenance([expression.object, ...expression.args], ctx);
    case 'sliceAccess': return derivedProvenance(
      [expression.object, expression.start, expression.end], ctx);
    case 'binaryOp': return derivedProvenance([expression.left, expression.right], ctx);
    case 'unaryOp': return derivedProvenance([expression.operand], ctx);
    case 'inExpr': return derivedProvenance([expression.element, expression.collection], ctx);
    case 'isExpr': return derivedProvenance([expression.value], ctx);
    case 'listLiteral': return derivedProvenance(expression.elements, ctx);
    case 'mapLiteral': return derivedProvenance(
      expression.entries.flatMap(({ key, value }) => [key, value]), ctx);
    case 'pathLiteral': return derivedProvenance(
      expression.segments.filter((segment): segment is Expression => typeof segment !== 'string'),
      ctx,
    );
    default: return null;
  }
}

export function sourceReceiverType(
  expression: Expression,
  ctx: SourceExpressionContext,
): InferredReceiverType | null {
  const ambientType = ambientReceiverType(ctx.service, sourceProvenance(expression, ctx));
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
      const objectType = sourceReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      if (expression.property === 'data' && objectType === 'document') return 'map';
      if (expression.object.type === 'mapLiteral') {
        const entry = expression.object.entries.find(({ key }) =>
          key.type === 'literal' && key.value === expression.property);
        return entry ? sourceReceiverType(entry.value, ctx) : null;
      }
      return null;
    }
    case 'bracketAccess': {
      const objectType = sourceReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      if (expression.object.type === 'listLiteral' && expression.index.type === 'literal' &&
          typeof expression.index.value === 'number' && Number.isInteger(expression.index.value)) {
        const element = expression.object.elements[expression.index.value];
        return element ? sourceReceiverType(element, ctx) : null;
      }
      if (expression.object.type === 'mapLiteral' && expression.index.type === 'literal') {
        const indexValue = expression.index.value;
        const entry = expression.object.entries.find(({ key }) =>
          key.type === 'literal' && key.value === indexValue);
        return entry ? sourceReceiverType(entry.value, ctx) : null;
      }
      if (objectType === 'string') return 'string';
      const objectPath = sourceProvenance(expression.object, ctx);
      if (ctx.service === 'firebase.storage' && Array.isArray(objectPath) &&
          (objectPath.join('.') === 'request.resource.metadata' ||
           objectPath.join('.') === 'resource.metadata')) return 'string';
      return null;
    }
    case 'sliceAccess': {
      const objectType = sourceReceiverType(expression.object, ctx);
      if (objectType === 'mixed') return 'mixed';
      return objectType === 'list' || objectType === 'string' ? objectType : null;
    }
    case 'methodCall': {
      const namespaceReturnType = methodReturnType(expression);
      if (expression.object.type === 'identifier' && namespaceReturnType) return namespaceReturnType;
      if (expression.method === 'get') {
        const objectPath = sourceProvenance(expression.object, ctx);
        if (ctx.service === 'firebase.storage' && Array.isArray(objectPath) &&
            (objectPath.join('.') === 'request.resource.metadata' ||
             objectPath.join('.') === 'resource.metadata')) return 'string';
        const fallback = expression.args[1];
        if (expression.object.type === 'mapLiteral' && expression.args[0]?.type === 'literal') {
          const keyValue = expression.args[0].value;
          const entry = expression.object.entries.find(({ key }) =>
            key.type === 'literal' && key.value === keyValue);
          if (entry) return sourceReceiverType(entry.value, ctx);
          return fallback ? sourceReceiverType(fallback, ctx) : null;
        }
        return fallback && sourceReceiverType(fallback, ctx) ? 'mixed' : null;
      }
      return methodReturnType(expression);
    }
    case 'binaryOp': {
      const left = sourceReceiverType(expression.left, ctx);
      const right = sourceReceiverType(expression.right, ctx);
      if (expression.op === '+' && (left === 'string' || right === 'string')) return 'string';
      if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expression.op)) return 'boolean';
      return ['+', '-', '*', '/', '%'].includes(expression.op) && left === 'number' && right === 'number'
        ? 'number'
        : null;
    }
    case 'unaryOp':
      if (expression.op === '!') return 'boolean';
      return expression.op === '-' && sourceReceiverType(expression.operand, ctx) === 'number'
        ? 'number'
        : null;
    case 'inExpr':
    case 'isExpr': return 'boolean';
    case 'ternary': {
      const consequent = sourceReceiverType(expression.consequent, ctx);
      const alternate = sourceReceiverType(expression.alternate, ctx);
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
      const nested = functionContext(
        fn,
        expression.args.map((argument) => expressionFacts(argument, ctx)),
        ctx,
      );
      for (const binding of fn.lets) {
        const facts = expressionFacts(binding.value, nested);
        nested.aliases.set(binding.name, facts.provenance);
        nested.receiverTypes.set(binding.name, facts.receiverType);
      }
      return sourceReceiverType(fn.body, nested);
    }
    default: return null;
  }
}
