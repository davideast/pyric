// Unified Intermediate Representation (IR) and parser for @pyric/rules/experimental/policy.
// Shared across compilePolicy (transitions), compileFunction (pure/loop functions),
// and compileBoundedModule (standalone zero-dependency ES modules).
import * as ohm from 'ohm-js';
import type { Expression, SourceLoc } from '../grammar/FirestoreAST.js';
import { firestoreGrammar, firestoreSemantics } from '../grammar/FirestoreParser.js';
import { boundSourceNesting } from '../grammar/source-nesting-bound.js';

export type PolicyExtension = 'bounded' | 'derive' | 'loops' | 'methods';
export type PolicyProgramKind = 'module' | 'function' | 'transition';

export type BoundedUnaryOpKind = 'map' | 'flatMap' | 'select' | 'any' | 'all' | 'count';
export type BoundedOpKind = BoundedUnaryOpKind | 'fold' | 'append';

export interface IRBoundedUnaryOp {
  type: 'boundedOp';
  op: BoundedUnaryOpKind;
  list: IRExpr;
  item: string;
  body: IRExpr;
  limit: number;
  loc?: SourceLoc;
}

export interface IRBoundedFoldOp {
  type: 'boundedOp';
  op: 'fold';
  list: IRExpr;
  initial: IRExpr;
  accumulator: string;
  item: string;
  lets: IRLetBinding[];
  body: IRExpr;
  limit: number;
  loc?: SourceLoc;
}

export interface IRBoundedAppendOp {
  type: 'boundedOp';
  op: 'append';
  list: IRExpr;
  suffix: IRExpr;
  limit: number;
  loc?: SourceLoc;
}

export type IRBoundedOp = IRBoundedUnaryOp | IRBoundedFoldOp | IRBoundedAppendOp;

export type IRExpr =
  | { type: 'literal'; value: string | number | boolean | null | Uint8Array; raw: string; loc?: SourceLoc }
  | { type: 'identifier'; name: string; loc?: SourceLoc }
  | { type: 'memberAccess'; object: IRExpr; property: string; loc?: SourceLoc }
  | { type: 'methodCall'; object: IRExpr; method: string; args: IRExpr[]; loc?: SourceLoc }
  | { type: 'bracketAccess'; object: IRExpr; index: IRExpr; loc?: SourceLoc }
  | { type: 'sliceAccess'; object: IRExpr; start: IRExpr; end: IRExpr; loc?: SourceLoc }
  | { type: 'binaryOp'; op: string; left: IRExpr; right: IRExpr; slashStartsPath?: true; loc?: SourceLoc }
  | { type: 'unaryOp'; op: string; operand: IRExpr; loc?: SourceLoc }
  | { type: 'ternary'; condition: IRExpr; consequent: IRExpr; alternate: IRExpr; loc?: SourceLoc }
  | { type: 'inExpr'; element: IRExpr; collection: IRExpr; loc?: SourceLoc }
  | { type: 'isExpr'; value: IRExpr; typeName: string; loc?: SourceLoc }
  | { type: 'listLiteral'; elements: IRExpr[]; loc?: SourceLoc }
  | { type: 'mapLiteral'; entries: Array<{ key: IRExpr; value: IRExpr }>; loc?: SourceLoc }
  | { type: 'pathLiteral'; raw: string; segments: Array<string | IRExpr>; isReference?: true; loc?: SourceLoc }
  | { type: 'functionCall'; name: string; args: IRExpr[]; loc?: SourceLoc }
  | IRBoundedOp;

export interface IRLetBinding {
  name: string;
  value: IRExpr;
  loc?: SourceLoc;
}

export interface IRGuardReturn {
  condition: IRExpr;
  result: IRExpr;
  loc?: SourceLoc;
}

export type IRLoopBody =
  | { kind: 'guards'; guards: IRGuardReturn[] }
  | { kind: 'update'; target: string; value: IRExpr };

export interface IRLoop {
  item: string;
  collection: IRExpr;
  step: IRLoopBody;
  loc?: SourceLoc;
}

export interface IRFunction {
  name: string;
  parameters: string[];
  exported: boolean;
  lets: IRLetBinding[];
  loop?: IRLoop;
  body: IRExpr;
  loc?: SourceLoc;
  returnLoc?: SourceLoc;
}

export interface IRDerivation {
  lets: IRLetBinding[];
  expr: IRExpr;
  loc?: SourceLoc;
}

export interface IRRequirement {
  name: string;
  location: string;
  source: string;
  lets: IRLetBinding[];
  condition: IRExpr;
  loc?: SourceLoc;
}

export interface IRTransition {
  name: string;
  derivation?: IRDerivation;
  requirements: IRRequirement[];
  loc?: SourceLoc;
}

export interface IRProgram {
  kind: PolicyProgramKind;
  extensions: string[];
  functions: IRFunction[];
  transition?: IRTransition;
}

/** Direct child expressions of any IR expression node. */
export function irChildren(expr: IRExpr): IRExpr[] {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return [];
    case 'memberAccess':
      return [expr.object];
    case 'methodCall':
      return [expr.object, ...expr.args];
    case 'bracketAccess':
      return [expr.object, expr.index];
    case 'sliceAccess':
      return [expr.object, expr.start, expr.end];
    case 'binaryOp':
      return [expr.left, expr.right];
    case 'unaryOp':
      return [expr.operand];
    case 'ternary':
      return [expr.condition, expr.consequent, expr.alternate];
    case 'inExpr':
      return [expr.element, expr.collection];
    case 'isExpr':
      return [expr.value];
    case 'listLiteral':
      return expr.elements;
    case 'mapLiteral':
      return expr.entries.flatMap((entry) => [entry.key, entry.value]);
    case 'pathLiteral':
      return expr.segments.filter((seg): seg is IRExpr => typeof seg !== 'string');
    case 'functionCall':
      return expr.args;
    case 'boundedOp':
      if (expr.op === 'append') return [expr.list, expr.suffix];
      if (expr.op === 'fold') return [expr.list, expr.initial, ...expr.lets.map((l) => l.value), expr.body];
      return [expr.list, expr.body];
  }
}

/** Pre-order traversal over an IR expression tree. */
export function walkIR(expr: IRExpr, visit: (node: IRExpr) => void): void {
  visit(expr);
  for (const child of irChildren(expr)) walkIR(child, visit);
}

/** True when an IR expression contains no boundedOp nodes and is a valid Rules Expression. */
export function isPureRulesExpr(expr: IRExpr): expr is Expression {
  let pure = true;
  walkIR(expr, (node) => {
    if (node.type === 'boundedOp') pure = false;
  });
  return pure;
}

/** Assert an IR expression is a pure Rules Expression (no boundedOp nodes). */
export function asPureRulesExpr(expr: IRExpr): Expression {
  if (!isPureRulesExpr(expr)) throw new Error('Expected a pure Rules expression without bounded ops');
  return expr;
}

/** Dotted identifier path for member access chains, or undefined. */
export function irFieldPath(expr: IRExpr): string | undefined {
  if (expr.type === 'identifier') return expr.name;
  if (expr.type !== 'memberAccess') return undefined;
  const parent = irFieldPath(expr.object);
  return parent ? `${parent}.${expr.property}` : undefined;
}

/** Convert an IR expression to its dotted path when pure, or extract all boundedOp kinds inside. */
export function collectBoundedOps(expr: IRExpr): BoundedOpKind[] {
  const ops = new Set<BoundedOpKind>();
  walkIR(expr, (node) => {
    if (node.type === 'boundedOp') ops.add(node.op);
  });
  return [...ops];
}

// Unified grammar extending FirestoreRules for all three experimental policy forms.
const policyGrammar = ohm.grammar(
  `UnifiedPolicy <: FirestoreRules {
  PolicyModule = ExtensionImport* ModuleFunction+
  PureFunction = ExtensionImport* ModuleFunction
  PolicyFile = ExtensionImport* ModuleFunction* "transition" ident "{" Derivation? Requirement+ "}"

  ExtensionImport = useToken extensionToken ident ";"
  ModuleFunction = LoopFunction | FunctionDef
  LoopFunction = "export"? functionToken ident "(" ParameterList ")" "{" LetBinding* ForOf ReturnStatement "}"

  useToken = "use" ~identChar
  extensionToken = "extension" ~identChar
  functionToken = "function" ~identChar
  constToken = "const" ~identChar
  ofToken = "of" ~identChar

  ForOf = "for" "(" constToken ident ofToken Expr ")" "{" LoopBody "}"
  LoopBody = GuardReturn+ -- guards
           | ident "=" Expr ";" -- update
  GuardReturn = "if" "(" Expr ")" ReturnStatement

  Derivation = "derive" "{" LetBinding* ReturnStatement "}"
  Requirement = "require" ident "{" LetBinding* ReturnStatement "}"

  Primary += BoundedExpr
  BoundedExpr
    = "bounded." boundedUnaryOp "(" Expr "," ident "=>" Expr "," digit+ ")" -- unary
    | "bounded.fold" "(" Expr "," Expr "," "(" ident "," ident ")" "=>" FoldBody "," digit+ ")" -- fold
  boundedUnaryOp = "flatMap" | "map" | "select" | "any" | "all" | "count"
  FoldBody = "{" LetBinding* ReturnStatement "}" -- block
           | Expr -- expression
}`,
  { FirestoreRules: firestoreGrammar },
);

interface FoldBodyAST {
  lets: IRLetBinding[];
  expr: IRExpr;
}

function locOf(node: { source: { getLineAndColumn(): { lineNum: number; colNum: number } } }): SourceLoc {
  const { lineNum, colNum } = node.source.getLineAndColumn();
  return { line: lineNum, col: colNum };
}

function normalizeAppendCall(expr: IRExpr): IRExpr {
  if (
    expr.type === 'methodCall' &&
    expr.object.type === 'identifier' &&
    expr.object.name === 'bounded' &&
    expr.method === 'append' &&
    expr.args.length === 3
  ) {
    const limitNode = expr.args[2]!;
    if (limitNode.type === 'literal' && typeof limitNode.value === 'number' && /^\d+$/.test(limitNode.raw)) {
      return {
        type: 'boundedOp',
        op: 'append',
        list: expr.args[0]!,
        suffix: expr.args[1]!,
        limit: Number(limitNode.raw),
        loc: expr.loc,
      };
    }
  }
  return expr;
}

const policySemantics = policyGrammar.extendSemantics(firestoreSemantics);
policySemantics.extendOperation<unknown>('toAST', {
  PolicyModule(imports, fns): IRProgram {
    return {
      kind: 'module',
      extensions: imports.children.map((n) => n.toAST() as string),
      functions: fns.children.map((n) => n.toAST() as IRFunction),
    };
  },
  PureFunction(imports, fn): IRProgram {
    return {
      kind: 'function',
      extensions: imports.children.map((n) => n.toAST() as string),
      functions: [fn.toAST() as IRFunction],
    };
  },
  PolicyFile(imports, fns, kw, name, _lb, derivation, requirements, _rb): IRProgram {
    return {
      kind: 'transition',
      extensions: imports.children.map((n) => n.toAST() as string),
      functions: fns.children.map((n) => n.toAST() as IRFunction),
      transition: {
        name: name.sourceString,
        derivation: derivation.children[0]?.toAST() as IRDerivation | undefined,
        requirements: requirements.children.map((n) => n.toAST() as IRRequirement),
        loc: locOf(kw),
      },
    };
  },
  ExtensionImport(_use, _extension, name, _semi): string {
    return name.sourceString;
  },
  ModuleFunction(fn): IRFunction {
    return fn.toAST() as IRFunction;
  },
  LoopFunction(exported, kw, name, _lp, parameters, _rp, _lb, lets, loop, ret, _rb): IRFunction {
    return {
      name: name.sourceString,
      exported: Boolean(exported.children.length),
      parameters: parameters.toAST() as string[],
      lets: lets.children.map((n) => n.toAST() as IRLetBinding),
      loop: loop.toAST() as IRLoop,
      body: ret.toAST() as IRExpr,
      loc: locOf(kw),
    };
  },
  ForOf(kw, _lp, _const, item, _of, collection, _rp, _lb, step, _rb): IRLoop {
    return {
      item: item.sourceString,
      collection: collection.toAST() as IRExpr,
      step: step.toAST() as IRLoopBody,
      loc: locOf(kw),
    };
  },
  LoopBody_guards(guards): IRLoopBody {
    return { kind: 'guards', guards: guards.children.map((n) => n.toAST() as IRGuardReturn) };
  },
  GuardReturn(kw, _lp, condition, _rp, ret): IRGuardReturn {
    return {
      condition: condition.toAST() as IRExpr,
      result: ret.toAST() as IRExpr,
      loc: locOf(kw),
    };
  },
  LoopBody_update(target, _eq, expr, _semi): IRLoopBody {
    return { kind: 'update', target: target.sourceString, value: expr.toAST() as IRExpr };
  },
  Derivation(kw, _lb, lets, ret, _rb): IRDerivation {
    return {
      lets: lets.children.map((n) => n.toAST() as IRLetBinding),
      expr: ret.toAST() as IRExpr,
      loc: locOf(kw),
    };
  },
  Requirement(kw, name, _lb, lets, ret, _rb): IRRequirement {
    const loc = locOf(kw);
    const exprNode = ret.child(1);
    return {
      name: name.sourceString,
      location: `${loc.line}:${loc.col}`,
      source: exprNode.sourceString,
      lets: lets.children.map((n) => n.toAST() as IRLetBinding),
      condition: ret.toAST() as IRExpr,
      loc,
    };
  },
  BoundedExpr_unary(kw, op, _lp, list, _c1, item, _arrow, body, _c2, limit, _rp): IRBoundedUnaryOp {
    return {
      type: 'boundedOp',
      op: op.sourceString as BoundedUnaryOpKind,
      list: list.toAST() as IRExpr,
      item: item.sourceString,
      body: body.toAST() as IRExpr,
      limit: Number(limit.sourceString),
      loc: locOf(kw),
    };
  },
  BoundedExpr_fold(kw, _lp, list, _c1, init, _c2, _al, acc, _c3, item, _ar, _arrow, body, _c4, limit, _rp): IRBoundedFoldOp {
    const step = body.toAST() as FoldBodyAST;
    return {
      type: 'boundedOp',
      op: 'fold',
      list: list.toAST() as IRExpr,
      initial: init.toAST() as IRExpr,
      accumulator: acc.sourceString,
      item: item.sourceString,
      lets: step.lets,
      body: step.expr,
      limit: Number(limit.sourceString),
      loc: locOf(kw),
    };
  },
  FoldBody_block(_lb, lets, ret, _rb): FoldBodyAST {
    return { lets: lets.children.map((n) => n.toAST() as IRLetBinding), expr: ret.toAST() as IRExpr };
  },
  FoldBody_expression(expr): FoldBodyAST {
    return { lets: [], expr: expr.toAST() as IRExpr };
  },
  PostfixExpr_methodCall(obj, _dot, method, _lp, args, _rp): IRExpr {
    const node: IRExpr = {
      type: 'methodCall',
      object: obj.toAST() as IRExpr,
      method: method.sourceString,
      args: args.asIteration().children.map((c) => c.toAST() as IRExpr),
      loc: locOf(this),
    };
    return normalizeAppendCall(node);
  },
});

const ENTRY_RULES: Record<PolicyProgramKind, string> = {
  module: 'PolicyModule',
  function: 'PureFunction',
  transition: 'PolicyFile',
};

const MAX_SOURCE_CHARS: Record<PolicyProgramKind, number> = {
  module: 32768,
  function: 8192,
  transition: 8192,
};

/** Parse source text into the unified Policy IR. */
export function parsePolicyIR(source: string, kind: PolicyProgramKind): IRProgram {
  const maxChars = MAX_SOURCE_CHARS[kind];
  if (source.length > maxChars) {
    const label = kind === 'module' ? 'Module' : 'Source';
    throw new Error(`${label} exceeds ${maxChars} characters`);
  }
  const bounded = boundSourceNesting(source);
  if ('offset' in bounded || bounded.elided?.length) {
    const label = kind === 'module' ? 'Module' : 'Source';
    throw new Error(`${label} exceeds parser nesting limit`);
  }
  const match = policyGrammar.match(source, ENTRY_RULES[kind]);
  if (match.failed()) throw new Error(match.message ?? 'Invalid policy source');
  return policySemantics(match).toAST() as IRProgram;
}
