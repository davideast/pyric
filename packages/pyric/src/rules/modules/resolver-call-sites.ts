import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';

type FunctionCallExpression = Extract<Expression, { type: 'functionCall' }>;
type CaptureReceiverType = 'path' | 'string';

export interface ModuleCallSite {
  args: readonly Expression[];
  receiverTypes: readonly (CaptureReceiverType | null)[];
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
  const addExpressions = (
    expressions: readonly Expression[],
    captures: ReadonlyMap<string, CaptureReceiverType>,
  ) => {
    for (const { name, args } of expressions.flatMap(collectFunctionCalls)) {
      if (name !== functionName) continue;
      sites.push({
        args,
        receiverTypes: args.map((arg) => arg.type === 'identifier' ? captures.get(arg.name) ?? null : null),
      });
    }
  };
  const addFunctions = (
    functions: readonly FunctionDef[],
    captures: ReadonlyMap<string, CaptureReceiverType>,
  ) => {
    for (const fn of functions) addExpressions([...fn.lets.map(({ value }) => value), fn.body], captures);
  };
  const addMatch = (match: MatchBlock, inherited: ReadonlyMap<string, CaptureReceiverType>) => {
    const captures = new Map(inherited);
    for (const segment of match.path.segments) {
      if (segment.type === 'wildcard') captures.set(segment.name, 'string');
      if (segment.type === 'recursive') captures.set(segment.name, 'path');
    }
    addFunctions(match.functions, captures);
    addExpressions(match.allows.map(({ condition }) => condition), captures);
    match.children.forEach((child) => addMatch(child, captures));
  };
  addFunctions(ast.functions ?? [], new Map());
  addFunctions(ast.service.functions ?? [], new Map());
  addMatch(ast.service.match, new Map());
  return sites;
}
