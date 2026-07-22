import type { Expression, FirestoreRules, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';
import type { RulesReceiverType } from './receiver-types.js';
import {
  expressionFacts,
  type SourceExpressionContext,
  type SourceExpressionFacts,
  type SourceFunctionDeclaration,
  type SourceProvenance,
} from './source-expression-analysis.js';

type FunctionCallExpression = Extract<Expression, { type: 'functionCall' }>;

export interface ModuleCallArgument {
  expression: Expression;
  provenance: SourceProvenance;
  receiverType: RulesReceiverType;
}

export interface ModuleCallSite {
  arguments: readonly ModuleCallArgument[];
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

function moduleArgument(facts: SourceExpressionFacts): ModuleCallArgument {
  return {
    expression: facts.expression,
    provenance: facts.provenance,
    receiverType: !facts.receiverType || facts.receiverType === 'mixed'
      ? 'unknown'
      : facts.receiverType,
  };
}

export function moduleCallSites(ast: FirestoreRules, functionName: string): readonly ModuleCallSite[] {
  const sites: ModuleCallSite[] = [];
  const declarations = new Map<FunctionDef, SourceFunctionDeclaration>();
  const service = ast.service.name === 'firebase.storage' ? 'firebase.storage' : 'cloud.firestore';

  const makeContext = (
    declaration: SourceFunctionDeclaration,
    stack: ReadonlySet<string> = new Set(),
  ): SourceExpressionContext => ({
    aliases: new Map(declaration.aliases),
    receiverTypes: new Map(declaration.receiverTypes),
    functions: declaration.functions,
    service,
    stack,
    declarations,
  });

  const analyzeFunction = (
    fn: FunctionDef,
    arguments_: readonly SourceExpressionFacts[],
    stack: ReadonlySet<string>,
  ) => {
    if (stack.has(fn.name)) return;
    const declaration = declarations.get(fn);
    if (!declaration) return;
    const aliases = new Map(declaration.aliases);
    const receiverTypes = new Map(declaration.receiverTypes);
    fn.parameters.forEach((parameter, index) => {
      aliases.set(parameter, arguments_[index]?.provenance ?? null);
      receiverTypes.set(parameter, arguments_[index]?.receiverType ?? null);
    });
    const ctx = makeContext(
      { aliases, receiverTypes, functions: declaration.functions },
      new Set([...stack, fn.name]),
    );
    for (const binding of fn.lets) {
      analyzeExpression(binding.value, ctx);
      const facts = expressionFacts(binding.value, ctx);
      ctx.aliases.set(binding.name, facts.provenance);
      ctx.receiverTypes.set(binding.name, facts.receiverType);
    }
    analyzeExpression(fn.body, ctx);
  };

  const analyzeExpression = (expression: Expression, ctx: SourceExpressionContext) => {
    for (const call of collectFunctionCalls(expression)) {
      const argumentFacts = call.args.map((argument) => expressionFacts(argument, ctx));
      if (call.name === functionName) {
        sites.push({ arguments: argumentFacts.map(moduleArgument) });
      }
      const sourceFunction = ctx.functions.get(call.name);
      if (sourceFunction) analyzeFunction(sourceFunction, argumentFacts, ctx.stack);
    }
  };

  const globalFunctions = new Map((ast.functions ?? []).map((fn) => [fn.name, fn]));
  const serviceFunctions = new Map(globalFunctions);
  for (const fn of ast.service.functions ?? []) serviceFunctions.set(fn.name, fn);
  for (const fn of ast.functions ?? []) {
    declarations.set(fn, { aliases: new Map(), receiverTypes: new Map(), functions: globalFunctions });
  }
  for (const fn of ast.service.functions ?? []) {
    declarations.set(fn, { aliases: new Map(), receiverTypes: new Map(), functions: serviceFunctions });
  }

  const addMatch = (
    match: MatchBlock,
    inherited: SourceFunctionDeclaration,
  ) => {
    const receiverTypes = new Map(inherited.receiverTypes);
    for (const segment of match.path.segments) {
      if (segment.type === 'wildcard') receiverTypes.set(segment.name, 'string');
      if (segment.type === 'recursive') receiverTypes.set(segment.name, 'path');
    }
    const functions = new Map(inherited.functions);
    const declaration = { aliases: inherited.aliases, receiverTypes, functions };
    for (const fn of match.functions) {
      functions.set(fn.name, fn);
      declarations.set(fn, declaration);
    }
    const ctx = makeContext(declaration);
    for (const { condition } of match.allows) analyzeExpression(condition, ctx);
    match.children.forEach((child) => addMatch(child, declaration));
  };
  addMatch(ast.service.match, {
    aliases: new Map(),
    receiverTypes: new Map(),
    functions: serviceFunctions,
  });
  return sites;
}
