import {
  completionPosition,
  copyExpressionPosition,
  expressionPosition,
  setCompletionPosition,
  setExpressionPosition,
} from '../grammar/expression-positions.js';
import type {
  Expression as SharedExpression,
  FunctionDef as SharedFunctionDef,
  MatchBlock as SharedMatchBlock,
  PathSegment as SharedPathSegment,
} from '../grammar/FirestoreAST.js';
import {
  resolveAuthoredLoc,
  type AuthoredSourceMap,
} from '../modules/resolver-browser.js';
import { numericLiteralValue } from '../simulator/rules-int.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import type {
  AllowRule,
  BinaryOp,
  Expr,
  FunctionDef,
  MatchBlock,
  PathArgSegment,
  PathSegment,
} from './rules.js';

const BINARY_OPS: ReadonlySet<BinaryOp> = new Set([
  '&&', '||', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%',
]);

/** The line an allow rule starts on: its own position, else its condition's. */
function allowLine(allow: SharedMatchBlock['allows'][number]): number | undefined {
  const ownLine = allow.loc?.line;
  if (ownLine !== undefined) return ownLine;
  return expressionPosition(allow.condition)?.line;
}

function remapConvertedPosition(node: object, sourceMap: AuthoredSourceMap): void {
  if (sourceMap.size === 0) return;
  const pos = expressionPosition(node);
  const comp = completionPosition(node);
  const hasDistinctCompletion = comp !== undefined && comp !== pos;
  if (pos !== undefined) {
    const mapped = resolveAuthoredLoc(sourceMap, pos.line, pos.column);
    if (mapped !== undefined && mapped.line !== pos.line) {
      setExpressionPosition(node, { line: mapped.line, column: pos.column });
    }
  }
  if (hasDistinctCompletion) {
    const mapped = resolveAuthoredLoc(sourceMap, comp.line, comp.column);
    if (mapped !== undefined && mapped.line !== comp.line) {
      setCompletionPosition(node, { line: mapped.line, column: comp.column });
    }
  }
}

function convertAllow(
  allow: SharedMatchBlock['allows'][number],
  sourceMap: AuthoredSourceMap,
): AllowRule {
  const rawLine = allowLine(allow);
  const rule: AllowRule = {
    verbs: allow.operations,
    condition: convertExpr(allow.condition, sourceMap),
  };
  if (rawLine !== undefined) {
    if (sourceMap.size > 0) {
      const mapped = resolveAuthoredLoc(sourceMap, rawLine);
      rule.line = mapped !== undefined ? mapped.line : rawLine;
    } else {
      rule.line = rawLine;
    }
  }
  return rule;
}

export function convertMatch(block: SharedMatchBlock, sourceMap: AuthoredSourceMap): MatchBlock {
  return {
    segments: block.path.segments.map(convertSegment),
    children: block.children.map((child) => convertMatch(child, sourceMap)),
    allows: block.allows.map((allow) => convertAllow(allow, sourceMap)),
    functions: block.functions.map((fn) => convertFunction(fn, sourceMap)),
  };
}

function convertSegment(seg: SharedPathSegment): PathSegment {
  switch (seg.type) {
    case 'literal':
      return { kind: 'literal', value: seg.value };
    case 'wildcard':
      return { kind: 'param', name: seg.name };
    case 'recursive':
      return { kind: 'wildcard', name: seg.name };
  }
}

export function convertFunction(fn: SharedFunctionDef, sourceMap: AuthoredSourceMap): FunctionDef {
  return {
    name: fn.name,
    params: fn.parameters,
    exported: fn.exported,
    lets: fn.lets.map((l) => {
      const binding = { name: l.name, value: convertExpr(l.value, sourceMap) };
      copyExpressionPosition(l, binding);
      remapConvertedPosition(binding, sourceMap);
      return binding;
    }),
    body: convertExpr(fn.body, sourceMap),
  };
}

/** The evaluator's node for a parsed expression, at the parsed node's source position. */
export function convertExpr(e: SharedExpression, sourceMap: AuthoredSourceMap): Expr {
  const converted = convertExprNode(e, sourceMap);
  copyExpressionPosition(e, converted);
  remapConvertedPosition(converted, sourceMap);
  return converted;
}

function convertExprNode(e: SharedExpression, sourceMap: AuthoredSourceMap): Expr {
  switch (e.type) {
    case 'literal':
      if (typeof e.value === 'number') {
        return { kind: 'literal', value: numericLiteralValue(e.value, e.raw) };
      }
      if (e.value instanceof Uint8Array) {
        return { kind: 'literal', value: new Bytes(e.value) };
      }
      return { kind: 'literal', value: e.value };
    case 'identifier':
      return { kind: 'ident', name: e.name };
    case 'memberAccess':
      return { kind: 'member', target: convertExpr(e.object, sourceMap), name: e.property };
    case 'methodCall':
      return {
        kind: 'methodcall',
        target: convertExpr(e.object, sourceMap),
        method: e.method,
        args: e.args.map((a) => convertExpr(a, sourceMap)),
      };
    case 'bracketAccess':
      return {
        kind: 'index',
        target: convertExpr(e.object, sourceMap),
        index: convertExpr(e.index, sourceMap),
      };
    case 'sliceAccess':
      return {
        kind: 'slice',
        target: convertExpr(e.object, sourceMap),
        start: convertExpr(e.start, sourceMap),
        end: convertExpr(e.end, sourceMap),
      };
    case 'binaryOp':
      if (!BINARY_OPS.has(e.op as BinaryOp)) {
        throw new SyntaxError(`Unsupported binary operator '${e.op}' in storage rules.`);
      }
      return {
        kind: 'binary',
        op: e.op as BinaryOp,
        left: convertExpr(e.left, sourceMap),
        right: convertExpr(e.right, sourceMap),
      };
    case 'unaryOp':
      if (e.op !== '!' && e.op !== '-') {
        throw new SyntaxError(`Unsupported unary operator '${e.op}' in storage rules.`);
      }
      return { kind: 'unary', op: e.op, arg: convertExpr(e.operand, sourceMap) };
    case 'ternary':
      return {
        kind: 'ternary',
        cond: convertExpr(e.condition, sourceMap),
        then: convertExpr(e.consequent, sourceMap),
        else: convertExpr(e.alternate, sourceMap),
      };
    case 'inExpr':
      return {
        kind: 'in',
        element: convertExpr(e.element, sourceMap),
        collection: convertExpr(e.collection, sourceMap),
      };
    case 'isExpr':
      return { kind: 'is', value: convertExpr(e.value, sourceMap), typeName: e.typeName };
    case 'listLiteral':
      return { kind: 'list', elements: e.elements.map((el) => convertExpr(el, sourceMap)) };
    case 'mapLiteral':
      return {
        kind: 'map',
        entries: e.entries.map((en) => ({
          key: convertExpr(en.key, sourceMap),
          value: convertExpr(en.value, sourceMap),
        })),
      };
    case 'pathLiteral':
      return {
        kind: 'path',
        segments: e.segments.map((seg): PathArgSegment => {
          if (typeof seg === 'string') {
            return { kind: 'literal', value: seg };
          }
          return { kind: 'interp', expr: convertExpr(seg, sourceMap) };
        }),
      };
    case 'functionCall':
      return { kind: 'call', name: e.name, args: e.args.map((a) => convertExpr(a, sourceMap)) };
    default: {
      const unhandled: never = e;
      throw new SyntaxError(`Unsupported expression construct: ${JSON.stringify(unhandled)}`);
    }
  }
}
