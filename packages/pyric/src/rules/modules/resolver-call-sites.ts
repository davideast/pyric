import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';

type FunctionCallExpression = Extract<Expression, { type: 'functionCall' }>;
type SourceReceiverType = 'boolean' | 'list' | 'map' | 'number' | 'path' | 'string' | 'unknown';

export interface ModuleCallSite {
  args: readonly Expression[];
  receiverTypes: readonly (SourceReceiverType | null)[];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

export function collectFunctionCalls(expr: Expression): FunctionCallExpression[] {
  const calls: FunctionCallExpression[] = [];
  const walk = (current: Expression) => {
    switch (current.type) {
      case 'functionCall': calls.push(current); current.args.forEach(walk); break;
      case 'binaryOp': walk(current.left); walk(current.right); break;
      case 'unaryOp': walk(current.operand); break;
      case 'methodCall': walk(current.object); current.args.forEach(walk); break;
      case 'memberAccess': walk(current.object); break;
      case 'bracketAccess': walk(current.object); walk(current.index); break;
      case 'sliceAccess': walk(current.object); walk(current.start); walk(current.end); break;
      case 'ternary': walk(current.condition); walk(current.consequent); walk(current.alternate); break;
      case 'inExpr': walk(current.element); walk(current.collection); break;
      case 'isExpr': walk(current.value); break;
      case 'listLiteral': current.elements.forEach(walk); break;
      case 'mapLiteral': current.entries.forEach(({ key, value }) => { walk(key); walk(value); }); break;
      case 'pathLiteral': current.segments.forEach((segment) => {
        if (typeof segment !== 'string') walk(segment);
      }); break;
      case 'literal':
      case 'identifier': break;
      default: assertNever(current);
    }
  };
  walk(expr);
  return calls;
}

export function moduleCallSites(ast: FirestoreRules, functionName: string): readonly ModuleCallSite[] {
  const sites: ModuleCallSite[] = [];
  type Environment = ReadonlyMap<string, SourceReceiverType | null>;
  type Functions = ReadonlyMap<string, FunctionDef>;

  const inferFunctionReturn = (
    fn: FunctionDef,
    argumentTypes: readonly (SourceReceiverType | null)[],
    functions: Functions,
    stack: ReadonlySet<string>,
  ): SourceReceiverType | null => {
    if (stack.has(fn.name)) return null;
    const environment = new Map<string, SourceReceiverType | null>();
    fn.parameters.forEach((parameter, index) => environment.set(parameter, argumentTypes[index] ?? null));
    const nestedStack = new Set([...stack, fn.name]);
    for (const binding of fn.lets) {
      environment.set(binding.name, inferType(binding.value, environment, functions, nestedStack));
    }
    return inferType(fn.body, environment, functions, nestedStack);
  };

  const inferType = (
    expression: Expression,
    environment: Environment,
    functions: Functions,
    stack: ReadonlySet<string>,
  ): SourceReceiverType | null => {
    switch (expression.type) {
      case 'identifier': return environment.get(expression.name) ?? null;
      case 'literal':
        if (typeof expression.value === 'string') return 'string';
        if (typeof expression.value === 'number') return 'number';
        if (typeof expression.value === 'boolean') return 'boolean';
        return null;
      case 'listLiteral': return 'list';
      case 'mapLiteral': return 'map';
      case 'pathLiteral': return 'path';
      case 'functionCall': {
        const fn = functions.get(expression.name);
        return fn ? inferFunctionReturn(
          fn,
          expression.args.map((arg) => inferType(arg, environment, functions, stack)),
          functions,
          stack,
        ) : null;
      }
      case 'methodCall':
        if (['lower', 'upper', 'trim', 'replace', 'join'].includes(expression.method)) return 'string';
        if (['concat', 'removeAll', 'split', 'values'].includes(expression.method)) return 'list';
        if (expression.method === 'get') {
          const fallback = expression.args[1];
          return fallback ? inferType(fallback, environment, functions, stack) : null;
        }
        if (['size', 'toMillis'].includes(expression.method)) return 'number';
        return null;
      case 'sliceAccess': return inferType(expression.object, environment, functions, stack);
      case 'binaryOp': {
        const left = inferType(expression.left, environment, functions, stack);
        const right = inferType(expression.right, environment, functions, stack);
        if (expression.op === '+' && (left === 'string' || right === 'string')) return 'string';
        return ['+', '-', '*', '/', '%'].includes(expression.op) && left === 'number' && right === 'number'
          ? 'number' : null;
      }
      case 'ternary': {
        const consequent = inferType(expression.consequent, environment, functions, stack);
        const alternate = inferType(expression.alternate, environment, functions, stack);
        return consequent && consequent === alternate ? consequent : null;
      }
      default: return null;
    }
  };

  const analyzeFunction = (
    fn: FunctionDef,
    argumentTypes: readonly (SourceReceiverType | null)[],
    functions: Functions,
    stack: ReadonlySet<string>,
  ) => {
    if (stack.has(fn.name)) return;
    const environment = new Map<string, SourceReceiverType | null>();
    fn.parameters.forEach((parameter, index) => environment.set(parameter, argumentTypes[index] ?? null));
    const nestedStack = new Set([...stack, fn.name]);
    for (const binding of fn.lets) {
      analyzeExpression(binding.value, environment, functions, nestedStack);
      environment.set(binding.name, inferType(binding.value, environment, functions, nestedStack));
    }
    analyzeExpression(fn.body, environment, functions, nestedStack);
  };

  const analyzeExpression = (
    expression: Expression,
    environment: Environment,
    functions: Functions,
    stack: ReadonlySet<string>,
  ) => {
    for (const call of collectFunctionCalls(expression)) {
      const argumentTypes = call.args.map((arg) =>
        inferType(arg, environment, functions, stack) ?? 'unknown');
      if (call.name === functionName) sites.push({ args: call.args, receiverTypes: argumentTypes });
      const sourceFunction = functions.get(call.name);
      if (sourceFunction) analyzeFunction(sourceFunction, argumentTypes, functions, stack);
    }
  };

  const serviceFunctions = new Map<string, FunctionDef>();
  for (const fn of ast.functions ?? []) serviceFunctions.set(fn.name, fn);
  for (const fn of ast.service.functions ?? []) serviceFunctions.set(fn.name, fn);
  const addMatch = (
    match: MatchBlock,
    inheritedEnvironment: Environment,
    inheritedFunctions: Functions,
  ) => {
    const captures = new Map(inheritedEnvironment);
    for (const segment of match.path.segments) {
      if (segment.type === 'wildcard') captures.set(segment.name, 'string');
      if (segment.type === 'recursive') captures.set(segment.name, 'path');
    }
    const functions = new Map(inheritedFunctions);
    for (const fn of match.functions) functions.set(fn.name, fn);
    for (const { condition } of match.allows) analyzeExpression(condition, captures, functions, new Set());
    match.children.forEach((child) => addMatch(child, captures, functions));
  };
  addMatch(ast.service.match, new Map(), serviceFunctions);
  return sites;
}
