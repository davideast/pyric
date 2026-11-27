import * as ohm from 'ohm-js';
import { boundSourceNesting } from './compile-limits.js';
import { SourcePositions, setCompletionPosition, setExpressionPosition } from './expression-positions.js';
import type {
  AllowRule,
  Expression,
  FirestoreRules,
  FunctionDef,
  LetBinding,
  MatchBlock,
  Operation,
  ServiceBlock,
} from './FirestoreAST.js';
import { FIRESTORE_RULES_OHM_SOURCE } from './FirestoreRules.ohm.generated.js';
import { decodeBytesLiteral, decodeStringLiteral, parsePath } from './literal-decoder.js';
import { addParenthesizedGroup } from './paren-groups.js';
import {
  attachFunctionSourceFile,
  buildParseError,
  leadingOffsetInfo,
  nestingFailure,
  shiftAstLines,
  shiftFunctionLocs,
  stackFailure,
  type ParseError,
} from './parser-loc-utils.js';
import { isFirestoreServiceName } from './service-blocks.js';
import { SEGMENT_DEPTH, isSegmentPlaceholder, matchSegmented, type PieceResult } from './source-segments.js';

export type { ParseError };

// The grammar source is inlined at SDK build time (see
// scripts/inline-grammar-rules.ts). This keeps the parser browser-safe -- no
// fs / url / path imports -- while preserving the .ohm file as the
// canonical edit surface.
const grammar = ohm.grammar(FIRESTORE_RULES_OHM_SOURCE);

export { grammar as firestoreGrammar };

export interface ParseResult {
  valid: boolean;
  errors: Array<{ message: string }>;
  /** Structured failure data when valid === false. Absent on success. */
  parseError?: ParseError;
}

const semantics = grammar.createSemantics();
export { semantics as firestoreSemantics };

/**
 * Line and column conversion for the source being built into an AST, set for
 * the duration of one `parseToASTOrError` build. Null otherwise, so a match
 * that builds no AST records no positions.
 */
let buildPositions: SourcePositions | null = null;

/** Records where `expr` starts: the first character of `node` in the parsed source. */
function placedAt<T extends object>(expr: T, node: { source: { startIdx: number } }): T {
  if (buildPositions !== null) setExpressionPosition(expr, buildPositions.at(node.source.startIdx));
  return expr;
}

/**
 * The service fields of a rules file holding `blocks`, in source order. The
 * ruleset's service is its `cloud.firestore` block, as production evaluates
 * a file with a Storage block before it (#1900); a file with no Firestore
 * block keeps its first block, so a Storage ruleset reads as before.
 */
function serviceFields(blocks: ServiceBlock[]): Pick<FirestoreRules, 'service' | 'services'> {
  const service = blocks.find((block) => isFirestoreServiceName(block.name)) ?? blocks[0]!;
  return { service, services: blocks };
}

/** Records where a `&&` completes: the first character of `node`, which spans the conjunction. */
function completesAt<T extends object>(expr: T, node: { source: { startIdx: number } }): T {
  if (buildPositions !== null) setCompletionPosition(expr, buildPositions.at(node.source.startIdx));
  return expr;
}

semantics.addOperation<any>('toAST', {
  RulesFile_versionFirst(version, imports, functions, services) {
    return {
      imports: imports.children.map((c: any) => c.toAST()),
      version: version.children.length > 0 ? version.children[0].toAST() : '1',
      functions: functions.children.map((c: any) => c.toAST()),
      ...serviceFields(services.children.map((c: any) => c.toAST())),
    } as FirestoreRules;
  },
  RulesFile_importsFirst(imports, version, functions, services) {
    return {
      imports: imports.children.map((c: any) => c.toAST()),
      version: version.toAST(),
      functions: functions.children.map((c: any) => c.toAST()),
      ...serviceFields(services.children.map((c: any) => c.toAST())),
    } as FirestoreRules;
  },
  ImportDecl(_import, _lb, names, _trailingComma, _rb, _from, moduleStr, _semi) {
    const { lineNum, colNum } = (_import.source as any).getLineAndColumn();
    return {
      functions: names.asIteration().children.map((c: any) => c.sourceString),
      module: moduleStr.toAST().value,
      loc: { line: lineNum, col: colNum },
    };
  },
  RulesVersion(_kw, _eq, str, _semi) {
    return str.toAST().value;
  },
  ServiceBlock(_kw, name, _lb, fnsBefore, docMatches, fnsAfter, _rb) {
    const { lineNum, colNum } = (
      _kw.source as { getLineAndColumn(): { lineNum: number; colNum: number } }
    ).getLineAndColumn();
    const matches = docMatches.children.map((c) => c.toAST() as MatchBlock);
    const functions: FunctionDef[] = [];
    for (const c of fnsBefore.children) {
      functions.push(c.toAST() as FunctionDef);
    }
    for (const iter of fnsAfter.children) {
      for (const c of iter.children) {
        functions.push(c.toAST() as FunctionDef);
      }
    }
    const block: ServiceBlock = {
      name: name.sourceString,
      functions,
      match: matches[0]!,
      loc: { line: lineNum, col: colNum },
    };
    if (matches.length > 1) {
      block.matches = matches;
    }
    return block;
  },
  DocumentsMatch(_kw, path, _lb, body, _rb) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      ...body.toAST(),
      path: parsePath(path.sourceString),
      loc: { line: lineNum, col: colNum },
    } as MatchBlock;
  },
  MatchBody(items) {
    const functions: FunctionDef[] = [];
    const allows: AllowRule[] = [];
    const children: MatchBlock[] = [];
    for (const item of items.children) {
      const ast = item.toAST();
      if (ast._kind === 'function') functions.push(ast);
      else if (ast._kind === 'allow') allows.push(ast);
      else if (ast._kind === 'match') children.push(ast);
    }
    return { functions, allows, children };
  },
  MatchBodyItem(item) {
    return item.toAST();
  },
  MatchBlock(_kw, path, _lb, body, _rb) {
    const { functions, allows, children } = body.toAST();
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      _kind: 'match',
      path: parsePath(path.sourceString),
      functions,
      allows,
      children,
      loc: { line: lineNum, col: colNum },
    };
  },
  AllowStatement(_kw, ops, _colon, _if, expr, _semi) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      _kind: 'allow',
      operations: ops.toAST(),
      condition: expr.toAST(),
      loc: { line: lineNum, col: colNum },
    };
  },
  OperationList(first, _commas, rest) {
    return [first.toAST(), ...rest.children.map((c: any) => c.toAST())];
  },
  Operation(op) {
    return op.sourceString as Operation;
  },
  FunctionDef(_export, _kw, name, _lp, params, _rp, _lb, body, _rb) {
    const { lets, expr, returnLoc } = body.toAST();
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      _kind: 'function',
      name: name.sourceString,
      parameters: params.toAST(),
      exported: _export.sourceString.trim() === 'export',
      lets,
      body: expr,
      returnLoc,
      loc: { line: lineNum, col: colNum },
    };
  },
  ParameterList(list) {
    return list.asIteration().children.map((c: any) => c.sourceString);
  },
  FunctionBody(lets, ret) {
    const { lineNum, colNum } = ((ret.child(1) as any).source as any).getLineAndColumn();
    return {
      lets: lets.children.map((c: any) => c.toAST()),
      expr: ret.toAST(),
      returnLoc: { line: lineNum, col: colNum },
    };
  },
  LetBinding(_kw, name, _eq, expr, _semi) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return placedAt(
      { name: name.sourceString, value: expr.toAST(), loc: { line: lineNum, col: colNum } } as LetBinding,
      this,
    );
  },
  ReturnStatement(_kw, expr, _semi) {
    return expr.toAST();
  },

  Expr(e) {
    return e.toAST();
  },
  Ternary_ternary(cond, _q, cons, _colon, alt) {
    return placedAt(
      { type: 'ternary', condition: cond.toAST(), consequent: cons.toAST(), alternate: alt.toAST() },
      this,
    );
  },
  LogicalOr_or(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '||', left: left.toAST(), right: right.toAST() }, _op);
  },
  LogicalAnd_and(left, _op, right) {
    return completesAt(
      placedAt({ type: 'binaryOp', op: '&&', left: left.toAST(), right: right.toAST() }, _op),
      this,
    );
  },
  InIsExpr_in(left, _op, right) {
    return placedAt({ type: 'inExpr', element: left.toAST(), collection: right.toAST() }, _op);
  },
  Equality_eq(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '==', left: left.toAST(), right: right.toAST() }, _op);
  },
  Equality_neq(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '!=', left: left.toAST(), right: right.toAST() }, _op);
  },
  Comparison_gte(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '>=', left: left.toAST(), right: right.toAST() }, _op);
  },
  Comparison_lte(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '<=', left: left.toAST(), right: right.toAST() }, _op);
  },
  Comparison_gt(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '>', left: left.toAST(), right: right.toAST() }, _op);
  },
  Comparison_lt(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '<', left: left.toAST(), right: right.toAST() }, _op);
  },
  Comparison_is(left, _op, typeName) {
    return placedAt({ type: 'isExpr', value: left.toAST(), typeName: typeName.sourceString }, _op);
  },
  Additive_add(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '+', left: left.toAST(), right: right.toAST() }, _op);
  },
  Additive_sub(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '-', left: left.toAST(), right: right.toAST() }, _op);
  },
  Multiplicative_mul(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '*', left: left.toAST(), right: right.toAST() }, _op);
  },
  Multiplicative_div(left, _op, right) {
    const source = _op.source as any;
    const next: string = source.sourceString.charAt(source.endIdx);
    const node: Extract<Expression, { type: 'binaryOp' }> = {
      type: 'binaryOp',
      op: '/',
      left: left.toAST(),
      right: right.toAST(),
    };
    if (!/\s/.test(next)) {
      node.slashStartsPath = true;
    }
    return placedAt(node, _op);
  },
  Multiplicative_mod(left, _op, right) {
    return placedAt({ type: 'binaryOp', op: '%', left: left.toAST(), right: right.toAST() }, _op);
  },
  UnaryExpr_not(_op, expr) {
    return placedAt({ type: 'unaryOp', op: '!', operand: expr.toAST() }, this);
  },
  UnaryExpr_neg(_op, expr) {
    return placedAt({ type: 'unaryOp', op: '-', operand: expr.toAST() }, this);
  },
  PostfixExpr_methodCall(obj, _dot, method, _lp, args, _rp) {
    return placedAt(
      {
        type: 'methodCall',
        object: obj.toAST(),
        method: method.sourceString,
        args: args.asIteration().children.map((c: any) => c.toAST()),
      },
      this,
    );
  },
  PostfixExpr_memberAccess(obj, _dot, member) {
    return placedAt({ type: 'memberAccess', object: obj.toAST(), property: member.sourceString }, this);
  },
  PostfixExpr_bracketAccess(obj, _lb, idx, _rb) {
    return placedAt({ type: 'bracketAccess', object: obj.toAST(), index: idx.toAST() }, this);
  },
  PostfixExpr_sliceAccess(obj, _lb, start, _colon, end, _rb) {
    return placedAt(
      { type: 'sliceAccess', object: obj.toAST(), start: start.toAST(), end: end.toAST() },
      this,
    );
  },
  Primary_paren(_lp, expr, _rp) {
    const inner = expr.toAST() as Expression;
    addParenthesizedGroup(inner);
    if ((inner.type === 'binaryOp' && inner.op === '&&') || isSegmentPlaceholder(inner)) {
      completesAt(inner, this);
    }
    return inner;
  },
  Primary_path(p) {
    return p.toAST();
  },
  Primary_list(l) {
    return l.toAST();
  },
  Primary_map(m) {
    return m.toAST();
  },
  Primary_functionCall(name, _lp, args, _rp) {
    return placedAt(
      {
        type: 'functionCall',
        name: name.sourceString,
        args: args.asIteration().children.map((c: any) => c.toAST()),
      },
      this,
    );
  },
  PathLiteral(_slash, cont, last) {
    const segments: Array<string | Expression> = [];
    for (const c of cont.children) segments.push(c.toAST());
    segments.push(last.toAST());
    return placedAt({ type: 'pathLiteral', raw: this.sourceString, segments }, this);
  },
  PathLitContSegment_interpolation(_dp, expr, _rps) {
    return expr.toAST();
  },
  PathLitContSegment_captureRef(_lb, name, _rbs) {
    return `{${name.sourceString}}`;
  },
  PathLitContSegment_parenLiteral(p) {
    return p.sourceString.slice(0, -1);
  },
  PathLitContSegment_literal(p) {
    return p.sourceString.slice(0, -1);
  },
  PathLitSegment_interpolation(_dp, expr, _rp) {
    return expr.toAST();
  },
  PathLitSegment_captureRef(_lb, name, _rb) {
    return `{${name.sourceString}}`;
  },
  PathLitSegment_parenLiteral(_lp, name, _rp) {
    return `(${name.sourceString})`;
  },
  PathLitSegment_literal(p) {
    return p.sourceString;
  },
  ListLiteral(_lb, items, _comma, _rb) {
    return placedAt(
      { type: 'listLiteral', elements: items.asIteration().children.map((c: any) => c.toAST()) },
      this,
    );
  },
  MapLiteral(_lb, entries, _comma, _rb) {
    return placedAt(
      { type: 'mapLiteral', entries: entries.asIteration().children.map((c: any) => c.toAST()) },
      this,
    );
  },
  MapEntry(key, _colon, value) {
    return { key: key.toAST(), value: value.toAST() };
  },
  literal(l) {
    return l.toAST();
  },
  number_float(_int, _dot, _frac) {
    return placedAt({ type: 'literal', value: parseFloat(this.sourceString), raw: this.sourceString }, this);
  },
  number_trailingDot(_int, _dot) {
    return placedAt({ type: 'literal', value: parseFloat(this.sourceString), raw: this.sourceString }, this);
  },
  number_leadingDot(_dot, _frac) {
    return placedAt({ type: 'literal', value: parseFloat(this.sourceString), raw: this.sourceString }, this);
  },
  number_int(_digits) {
    return placedAt({ type: 'literal', value: parseInt(this.sourceString, 10), raw: this.sourceString }, this);
  },
  string_single(_q1, chars, _q2) {
    return placedAt(
      { type: 'literal', value: decodeStringLiteral(chars.sourceString), raw: this.sourceString },
      this,
    );
  },
  string_double(_q1, chars, _q2) {
    return placedAt(
      { type: 'literal', value: decodeStringLiteral(chars.sourceString), raw: this.sourceString },
      this,
    );
  },
  bytes_single(_prefix, _q1, chars, _q2) {
    return placedAt(
      { type: 'literal', value: decodeBytesLiteral(chars.sourceString), raw: this.sourceString },
      this,
    );
  },
  bytes_double(_prefix, _q1, chars, _q2) {
    return placedAt(
      { type: 'literal', value: decodeBytesLiteral(chars.sourceString), raw: this.sourceString },
      this,
    );
  },
  bool_true(_) {
    return placedAt({ type: 'literal', value: true, raw: 'true' }, this);
  },
  bool_false(_) {
    return placedAt({ type: 'literal', value: false, raw: 'false' }, this);
  },
  null(_) {
    return placedAt({ type: 'literal', value: null, raw: 'null' }, this);
  },
  ident(_start, _rest) {
    return placedAt({ type: 'identifier', name: this.sourceString }, this);
  },
  _nonterminal(...children) {
    if (children.length === 1) return children[0].toAST();
    return children.map((c: any) => c.toAST());
  },
  _terminal() {
    return this.sourceString;
  },
});

function matchGrammar(text: string, startRule: string | undefined): ohm.MatchResult {
  if (startRule === undefined) return grammar.match(text);
  return grammar.match(text, startRule);
}

function matchPiece(
  text: string,
  startRule: string | undefined,
  offset: number,
  prefix: number,
  errorSource: string,
  baseOffset: number,
): PieceResult<ParseError> {
  const match = matchGrammar(text, startRule);
  if (!match.succeeded()) {
    return { ok: false, error: buildParseError(match, errorSource, baseOffset + offset - prefix) };
  }
  const sourcePositions = buildPositions;
  if (sourcePositions !== null && (offset !== 0 || prefix !== 0)) {
    const start = sourcePositions.at(offset);
    buildPositions = new SourcePositions(text, start.line - 1, start.column - 1 - prefix);
  }
  try {
    return { ok: true, ast: semantics(match).toAST() as object };
  } finally {
    buildPositions = sourcePositions;
  }
}

function matchBounded(
  trimmed: string,
  startRule: string | undefined,
  buildAst: boolean,
  errorSource = trimmed,
  baseOffset = 0,
  segmentDepth = SEGMENT_DEPTH,
): { ok: true; value: unknown } | { ok: false; error: ParseError } {
  const bounded = boundSourceNesting(trimmed);
  if (!('source' in bounded)) {
    return {
      ok: false,
      error: nestingFailure(errorSource, { offset: baseOffset + bounded.offset, expected: bounded.expected }),
    };
  }
  const matchSource = (source: string, rule: string | undefined, needAst: boolean, at: number): PieceResult<ParseError> =>
    matchSegmented(
      source,
      rule,
      (text, r, offset, prefix) => {
        if (needAst || text !== source) return matchPiece(text, r, offset, prefix, errorSource, at);
        const m = matchGrammar(text, r);
        if (!m.succeeded()) return { ok: false, error: buildParseError(m, errorSource, at) };
        return { ok: true, ast: {} };
      },
      0,
      0,
      segmentDepth,
    );
  try {
    const matched = matchSource(bounded.source, startRule, buildAst, baseOffset);
    if (!matched.ok) return matched;
    if (bounded.elided !== undefined) {
      const queue = bounded.elided.map((e) => ({ offset: baseOffset + e.offset, text: e.text }));
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]!;
        const sub = boundSourceNesting(item.text);
        if (!('source' in sub)) {
          return {
            ok: false,
            error: nestingFailure(errorSource, { offset: item.offset + sub.offset, expected: sub.expected }),
          };
        }
        const subMatched = matchSource(sub.source, 'Expr', false, item.offset);
        if (!subMatched.ok) return subMatched;
        if (sub.elided !== undefined) {
          for (const child of sub.elided) {
            queue.push({ offset: item.offset + child.offset, text: child.text });
          }
        }
      }
    }
    return { ok: true, value: matched.ast };
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, error: stackFailure(errorSource) };
    throw e;
  }
}

function checkStrictParse(input: string, startRule: string | undefined, emptyMsg: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, errors: [{ message: emptyMsg }] };
  const leadingTrimmed = input.length - input.trimStart().length;
  const matched = matchBounded(trimmed, startRule, false, input.trimEnd(), leadingTrimmed);
  if (!matched.ok) return { valid: false, errors: [{ message: matched.error.message }], parseError: matched.error };
  return { valid: true, errors: [] };
}

export function parseExpression(input: string): ParseResult {
  return checkStrictParse(input, 'Expr', 'Empty expression');
}

export function parseRulesFile(input: string): ParseResult {
  return checkStrictParse(input, undefined, 'Empty rules file');
}

export function parseToAST(input: string): FirestoreRules | null {
  const result = parseToASTOrError(input);
  return result.ok ? result.ast : null;
}

export interface ParseOptions {
  segmentDepth?: number;
}

export function parseToASTOrError(
  input: string,
  options: ParseOptions = {},
): { ok: true; ast: FirestoreRules } | { ok: false; error: ParseError } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { line: 1, column: 1, offset: 0, expected: '', actual: '', message: 'Empty rules file' },
    };
  }
  const { leadingTrimmed, leadingLineOffset, initialColumnOffset } = leadingOffsetInfo(input);
  buildPositions = new SourcePositions(trimmed, leadingLineOffset, initialColumnOffset);
  let built: ReturnType<typeof matchBounded>;
  try {
    built = matchBounded(trimmed, undefined, true, input.trimEnd(), leadingTrimmed, options.segmentDepth);
  } finally {
    buildPositions = null;
  }
  if (!built.ok) return built;
  const ast = built.value as FirestoreRules;
  if (leadingLineOffset > 0) shiftAstLines(ast, leadingLineOffset);
  return { ok: true, ast };
}

export function parseFunctions(input: string, sourceFile?: string): FunctionDef[] | null {
  const wrapped = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n${input}\n  }\n}`;
  const ast = parseToAST(wrapped);
  if (ast === null) return null;
  const root = ast.service.match;
  if (root.allows.length > 0 || root.children.length > 0) return null;
  const fns = root.functions;
  for (const fn of fns) {
    shiftFunctionLocs(fn, -3);
    if (sourceFile !== undefined) attachFunctionSourceFile(fn, sourceFile);
  }
  return fns;
}
