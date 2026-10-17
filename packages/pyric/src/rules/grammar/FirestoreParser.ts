import * as ohm from 'ohm-js';
import { FIRESTORE_RULES_OHM_SOURCE } from './FirestoreRules.ohm.generated.js';
import type {
  FirestoreRules, ServiceBlock, MatchBlock, PathPattern, PathSegment,
  AllowRule, Operation, FunctionDef, LetBinding, Expression,
} from './FirestoreAST.js';
import { addParenthesizedGroup } from './paren-groups.js';
import { boundSourceNesting, type SourceNestingFailure } from './compile-limits.js';
import { MAX_BRACKET_DEPTH } from './bracket-scan.js';
import { SourcePositions, setCompletionPosition, setExpressionPosition } from './expression-positions.js';

// The grammar source is inlined at SDK build time (see
// scripts/inline-grammar.ts). This keeps the parser browser-safe — no
// fs / url / path imports — while preserving the .ohm file as the
// canonical edit surface.
export const grammar = ohm.grammar(FIRESTORE_RULES_OHM_SOURCE);

export interface ParseResult {
  valid: boolean;
  errors: Array<{ message: string }>;
  /** Structured failure data when valid === false. Absent on success. */
  parseError?: ParseError;
}

/**
 * Structured parse failure. Carries enough information for a caller to
 * surface a useful diagnostic without re-parsing or string-scraping.
 *
 * - `line` / `column` are 1-based.
 * - `offset` is the byte offset into the trimmed source where parsing failed.
 * - `expected` is what the grammar wanted next (e.g. ")" or "an identifier").
 * - `actual` is a short snippet from the source at the failure point.
 * - `message` is the human-readable ohm message (multi-line, includes a caret).
 */
export interface ParseError {
  line: number;
  column: number;
  offset: number;
  expected: string;
  actual: string;
  message: string;
}

// ---- Semantics for AST generation ----

const semantics = grammar.createSemantics();

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

/** Records where a `&&` completes: the first character of `node`, which spans the conjunction. */
function completesAt<T extends object>(expr: T, node: { source: { startIdx: number } }): T {
  if (buildPositions !== null) setCompletionPosition(expr, buildPositions.at(node.source.startIdx));
  return expr;
}

semantics.addOperation<any>('toAST', {
  // Both grammar alternatives (`versionFirst` and `importsFirst`)
  // normalize into the same AST shape — caller code reads
  // `ast.version`, `ast.imports`, and `ast.service` regardless of
  // which order the source declared them in.
  RulesFile_versionFirst(version, imports, functions, service) {
    return {
      imports: imports.children.map((c: any) => c.toAST()),
      // `rules_version` is optional in production (absent means '1').
      version: version.children.length > 0 ? version.children[0].toAST() : '1',
      functions: functions.children.map((c: any) => c.toAST()),
      service: service.toAST(),
    } as FirestoreRules;
  },
  RulesFile_importsFirst(imports, version, functions, service) {
    return {
      imports: imports.children.map((c: any) => c.toAST()),
      version: version.toAST(),
      functions: functions.children.map((c: any) => c.toAST()),
      service: service.toAST(),
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
  ServiceBlock(_kw, name, _lb, fnsBefore, docMatch, fnsAfter, _rb) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      name: name.sourceString,
      functions: [
        ...fnsBefore.children.map((c: any) => c.toAST()),
        ...fnsAfter.children.map((c: any) => c.toAST()),
      ],
      match: docMatch.toAST(),
      loc: { line: lineNum, col: colNum },
    } as ServiceBlock;
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
  MatchBodyItem(item) { return item.toAST(); },
  MatchBlock(_kw, path, _lb, body, _rb) {
    const { functions, allows, children } = body.toAST();
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return { _kind: 'match', path: parsePath(path.sourceString), functions, allows, children, loc: { line: lineNum, col: colNum } };
  },
  AllowStatement(_kw, ops, _colon, _if, expr, _semi) {
    // Source position of the `allow` keyword. Ohm's `getLineAndColumn`
    // returns 1-based line + column over the trimmed input the grammar
    // matched against (see `parseToASTOrError`, which trims before
    // matching). Trimming only strips outer whitespace, so `allow` line
    // numbers stay stable — but a caller comparing to a non-trimmed
    // source must account for any leading blank lines.
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return { _kind: 'allow', operations: ops.toAST(), condition: expr.toAST(), loc: { line: lineNum, col: colNum } };
  },
  OperationList(first, _commas, rest) {
    return [first.toAST(), ...rest.children.map((c: any) => c.toAST())];
  },
  Operation(op) { return op.sourceString as Operation; },
  FunctionDef(_export, _kw, name, _lp, params, _rp, _lb, body, _rb) {
    const { lets, expr, returnLoc } = body.toAST();
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return {
      _kind: 'function', name: name.sourceString, parameters: params.toAST(),
      exported: _export.sourceString.trim() === 'export', lets, body: expr, returnLoc, loc: { line: lineNum, col: colNum },
    };
  },
  ParameterList(list) {
    return list.asIteration().children.map((c: any) => c.sourceString);
  },
  FunctionBody(lets, ret) {
    // The return expression is the second child of `ReturnStatement`, after the keyword.
    const { lineNum, colNum } = ((ret.child(1) as any).source as any).getLineAndColumn();
    return { lets: lets.children.map((c: any) => c.toAST()), expr: ret.toAST(), returnLoc: { line: lineNum, col: colNum } };
  },
  LetBinding(_kw, name, _eq, expr, _semi) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    // Placed at `let`, where production reports a limit reached on the binding.
    return placedAt({ name: name.sourceString, value: expr.toAST(), loc: { line: lineNum, col: colNum } } as LetBinding, this);
  },
  ReturnStatement(_kw, expr, _semi) { return expr.toAST(); },

  // Expressions
  Expr(e) { return e.toAST(); },
  Ternary_ternary(cond, _q, cons, _colon, alt) {
    return placedAt({ type: 'ternary', condition: cond.toAST(), consequent: cons.toAST(), alternate: alt.toAST() }, this);
  },
  LogicalOr_or(left, _op, right) { return placedAt({ type: 'binaryOp', op: '||', left: left.toAST(), right: right.toAST() }, _op); },
  LogicalAnd_and(left, _op, right) { return completesAt(placedAt({ type: 'binaryOp', op: '&&', left: left.toAST(), right: right.toAST() }, _op), this); },
  InIsExpr_in(left, _op, right) { return placedAt({ type: 'inExpr', element: left.toAST(), collection: right.toAST() }, _op); },
  InIsExpr_is(left, _op, typeName) { return placedAt({ type: 'isExpr', value: left.toAST(), typeName: typeName.sourceString }, _op); },
  Equality_eq(left, _op, right) { return placedAt({ type: 'binaryOp', op: '==', left: left.toAST(), right: right.toAST() }, _op); },
  Equality_neq(left, _op, right) { return placedAt({ type: 'binaryOp', op: '!=', left: left.toAST(), right: right.toAST() }, _op); },
  Comparison_gte(left, _op, right) { return placedAt({ type: 'binaryOp', op: '>=', left: left.toAST(), right: right.toAST() }, _op); },
  Comparison_lte(left, _op, right) { return placedAt({ type: 'binaryOp', op: '<=', left: left.toAST(), right: right.toAST() }, _op); },
  Comparison_gt(left, _op, right) { return placedAt({ type: 'binaryOp', op: '>', left: left.toAST(), right: right.toAST() }, _op); },
  Comparison_lt(left, _op, right) { return placedAt({ type: 'binaryOp', op: '<', left: left.toAST(), right: right.toAST() }, _op); },
  Additive_add(left, _op, right) { return placedAt({ type: 'binaryOp', op: '+', left: left.toAST(), right: right.toAST() }, _op); },
  Additive_sub(left, _op, right) { return placedAt({ type: 'binaryOp', op: '-', left: left.toAST(), right: right.toAST() }, _op); },
  Multiplicative_mul(left, _op, right) { return placedAt({ type: 'binaryOp', op: '*', left: left.toAST(), right: right.toAST() }, _op); },
  Multiplicative_div(left, _op, right) {
    const source = _op.source as any;
    const next: string = source.sourceString.charAt(source.endIdx);
    return placedAt({
      type: 'binaryOp', op: '/', left: left.toAST(), right: right.toAST(),
      ...(/\s/.test(next) ? {} : { slashStartsPath: true }),
    }, _op);
  },
  Multiplicative_mod(left, _op, right) { return placedAt({ type: 'binaryOp', op: '%', left: left.toAST(), right: right.toAST() }, _op); },
  UnaryExpr_not(_op, expr) { return placedAt({ type: 'unaryOp', op: '!', operand: expr.toAST() }, this); },
  UnaryExpr_neg(_op, expr) { return placedAt({ type: 'unaryOp', op: '-', operand: expr.toAST() }, this); },
  PostfixExpr_methodCall(obj, _dot, method, _lp, args, _rp) {
    return placedAt({ type: 'methodCall', object: obj.toAST(), method: method.sourceString, args: args.asIteration().children.map((c: any) => c.toAST()) }, this);
  },
  PostfixExpr_memberAccess(obj, _dot, member) { return placedAt({ type: 'memberAccess', object: obj.toAST(), property: member.sourceString }, this); },
  PostfixExpr_bracketAccess(obj, _lb, idx, _rb) { return placedAt({ type: 'bracketAccess', object: obj.toAST(), index: idx.toAST() }, this); },
  PostfixExpr_sliceAccess(obj, _lb, start, _colon, end, _rb) {
    return placedAt({ type: 'sliceAccess', object: obj.toAST(), start: start.toAST(), end: end.toAST() }, this);
  },
  Primary_paren(_lp, expr, _rp) {
    const inner = expr.toAST() as Expression;
    addParenthesizedGroup(inner);
    // A parenthesized conjunction completes at its opening parenthesis.
    if (inner.type === 'binaryOp' && inner.op === '&&') completesAt(inner, this);
    return inner;
  },
  Primary_path(p) { return p.toAST(); },
  Primary_list(l) { return l.toAST(); },
  Primary_map(m) { return m.toAST(); },
  Primary_functionCall(name, _lp, args, _rp) {
    return placedAt({ type: 'functionCall', name: name.sourceString, args: args.asIteration().children.map((c: any) => c.toAST()) }, this);
  },
  PathLiteral(_slash, cont, last) {
    const segments: Array<string | Expression> = [];
    for (const c of cont.children) segments.push(c.toAST());
    segments.push(last.toAST());
    return placedAt({ type: 'pathLiteral', raw: this.sourceString, segments }, this);
  },
  PathLitContSegment_interpolation(_dp, expr, _rps) { return expr.toAST(); },
  PathLitContSegment_captureRef(_lb, name, _rbs) {
    firstCaptureRefOffset ??= this.source.startIdx;
    return `{${name.sourceString}}`;
  },
  PathLitContSegment_parenLiteral(p) { return p.sourceString.slice(0, -1); },
  PathLitContSegment_literal(p) { return p.sourceString.slice(0, -1); },
  PathLitSegment_interpolation(_dp, expr, _rp) { return expr.toAST(); },
  // Match-style `{ident}` is INVALID syntax inside path literals — Firestore
  // requires `$(ident)` for interpolation. We parse it anyway (instead of
  // letting it fall through to MapLiteral and produce an opaque "expected ':'"
  // error) so the linter can emit a precise INVALID_PATH_INTERPOLATION
  // diagnostic. The braces are preserved in the segment string so the linter
  // can detect it via prefix check (legitimate pathIdent segments cannot
  // start with '{').
  PathLitSegment_captureRef(_lb, name, _rb) {
    firstCaptureRefOffset ??= this.source.startIdx;
    return `{${name.sourceString}}`;
  },
  // Parenthesized database id in a cross-service Firestore lookup path,
  // e.g. `firestore.get(/databases/(default)/documents/...)`. The parens
  // are part of the production path shape, so keep them in the segment.
  PathLitSegment_parenLiteral(_lp, name, _rp) { return `(${name.sourceString})`; },
  PathLitSegment_literal(p) { return p.sourceString; },
  ListLiteral(_lb, items, _comma, _rb) {
    return placedAt({ type: 'listLiteral', elements: items.asIteration().children.map((c: any) => c.toAST()) }, this);
  },
  MapLiteral(_lb, entries, _comma, _rb) {
    return placedAt({ type: 'mapLiteral', entries: entries.asIteration().children.map((c: any) => c.toAST()) }, this);
  },
  MapEntry(key, _colon, value) {
    return { key: key.toAST(), value: value.toAST() };
  },
  literal(l) { return l.toAST(); },
  number_float(_int, _dot, _frac) {
    return placedAt({ type: 'literal', value: parseFloat(this.sourceString), raw: this.sourceString }, this);
  },
  number_int(_digits) {
    return placedAt({ type: 'literal', value: parseInt(this.sourceString, 10), raw: this.sourceString }, this);
  },
  string_single(_q1, chars, _q2) {
    return placedAt({ type: 'literal', value: decodeStringLiteral(chars.sourceString), raw: this.sourceString }, this);
  },
  string_double(_q1, chars, _q2) {
    return placedAt({ type: 'literal', value: decodeStringLiteral(chars.sourceString), raw: this.sourceString }, this);
  },
  bytes_single(_prefix, _q1, chars, _q2) {
    return placedAt({ type: 'literal', value: decodeBytesLiteral(chars.sourceString), raw: this.sourceString }, this);
  },
  bytes_double(_prefix, _q1, chars, _q2) {
    return placedAt({ type: 'literal', value: decodeBytesLiteral(chars.sourceString), raw: this.sourceString }, this);
  },
  bool_true(_) { return placedAt({ type: 'literal', value: true, raw: 'true' }, this); },
  bool_false(_) { return placedAt({ type: 'literal', value: false, raw: 'false' }, this); },
  null(_) { return placedAt({ type: 'literal', value: null, raw: 'null' }, this); },
  ident(_start, _rest) { return placedAt({ type: 'identifier', name: this.sourceString }, this); },
  _nonterminal(...children) {
    if (children.length === 1) return children[0].toAST();
    return children.map((c: any) => c.toAST());
  },
  _terminal() { return this.sourceString; },
});

// ---- String and bytes literal decoding ----
// The body of a string or bytes literal, after the grammar's `stringEscape`
// or `literalEscape` rule has accepted it. `readLiteralBody` splits the body
// into plain text and escape values: `\xHH` and `\ooo` are the value of their
// digits, `\uHHHH` is one UTF-16 code unit, and a simple escape is the code of
// the character it names. A string literal takes each value as a UTF-16 code
// unit; a bytes literal encodes plain text as UTF-8 and takes each escape
// value as one byte.
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  '\\': 0x5c, '\'': 0x27, '"': 0x22, n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c,
};

function readLiteralBody(body: string, onText: (text: string) => void, onEscape: (value: number) => void): void {
  let textStart = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '\\') {
      i++;
      continue;
    }
    if (i > textStart) onText(body.slice(textStart, i));
    const next = body[i + 1]!;
    if (next === 'x') {
      onEscape(parseInt(body.slice(i + 2, i + 4), 16));
      i += 4;
    } else if (next === 'u') {
      onEscape(parseInt(body.slice(i + 2, i + 6), 16));
      i += 6;
    } else if (next >= '0' && next <= '3') {
      onEscape(parseInt(body.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      onEscape(SIMPLE_ESCAPES[next]!);
      i += 2;
    }
    textStart = i;
  }
  if (body.length > textStart) onText(body.slice(textStart));
}

function decodeStringLiteral(body: string): string {
  let out = '';
  readLiteralBody(body, (text) => { out += text; }, (value) => { out += String.fromCharCode(value); });
  return out;
}

function decodeBytesLiteral(body: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();
  readLiteralBody(body, (text) => { out.push(...encoder.encode(text)); }, (value) => { out.push(value); });
  return new Uint8Array(out);
}

// ---- Path parsing helper ----

function parsePath(raw: string): PathPattern {
  const segments: PathSegment[] = [];
  const parts = raw.split('/').filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const inner = part.slice(1, -1);
      if (inner.endsWith('=**')) {
        segments.push({ type: 'recursive', name: inner.slice(0, -3) });
      } else {
        segments.push({ type: 'wildcard', name: inner });
      }
    } else {
      segments.push({ type: 'literal', value: part });
    }
  }
  return { raw, segments };
}

// ---- Failure diagnostics ----

/**
 * Build a ParseError from an ohm failed MatchResult plus the trimmed source
 * the grammar saw. The ohm match is the only place line/column/expected info
 * exists — without this conversion that data is lost when the match goes out
 * of scope.
 */
let firstCaptureRefOffset: number | null = null;

function buildParseError(match: ohm.MatchResult, source: string, baseOffset: number = 0): ParseError {
  const offset = baseOffset + ((match as any).getRightmostFailurePosition?.() ?? 0);
  const expected = (match as any).getExpectedText?.() ?? '';
  return failureAt(source, offset, expected, (match as any).message ?? 'Parse error');
}

/** A ParseError at `offset` of `source`, with 1-based line and column and the snippet there. */
function failureAt(source: string, offset: number, expected: string, message: string): ParseError {
  // 1-based line/column, derived by counting newlines up to the offset.
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  const column = offset - lastNewline; // 1-based
  // Snippet: from the failure point to end-of-line, capped at 40 chars.
  let endOfLine = source.indexOf('\n', offset);
  if (endOfLine === -1) endOfLine = source.length;
  const actual = source.slice(offset, Math.min(endOfLine, offset + 40));
  return { line, column, offset, expected, actual, message };
}

/** The failure for source nesting past the parser's bracket depth bound. */
function nestingFailure(source: string, failure: SourceNestingFailure): ParseError {
  const error = failureAt(source, failure.offset, failure.expected, '');
  error.message = `Line ${error.line}, col ${error.column}: Brackets nest more than ${MAX_BRACKET_DEPTH} levels deep: the rules parser reads at most ${MAX_BRACKET_DEPTH}, a limit of this parser, not of production.`;
  return error;
}

/**
 * The failure for source the parser exhausted the host stack on. The bracket
 * scan bounds bracket nesting, so this is a long run of prefix operators or
 * a chain of thousands of terms, and no position is known.
 */
function stackFailure(source: string): ParseError {
  const error = failureAt(source, 0, 'an expression with fewer chained terms', '');
  error.message = 'Line 1, col 1: The rules source chains more terms than the rules parser reads.';
  return error;
}

/**
 * Match `trimmed` from `startRule` and build a value from the match, never
 * descending into a group production rejects as too complex or past the
 * bracket depth bound (`boundSourceNesting`), and never letting a stack
 * overflow escape.
 */
function matchBounded<T>(
  trimmed: string,
  startRule: string | undefined,
  build: (match: ohm.MatchResult) => T,
  errorSource: string = trimmed,
  baseOffset: number = 0,
): { ok: true; value: T } | { ok: false; error: ParseError } {
  const bounded = boundSourceNesting(trimmed);
  if (!('source' in bounded)) {
    return { ok: false, error: nestingFailure(errorSource, { offset: baseOffset + bounded.offset, expected: bounded.expected }) };
  }
  try {
    const match = startRule === undefined ? grammar.match(bounded.source) : grammar.match(bounded.source, startRule);
    if (!match.succeeded()) return { ok: false, error: buildParseError(match, errorSource, baseOffset) };
    if (bounded.elided !== undefined) {
      const queue = bounded.elided.map((e) => ({ offset: baseOffset + e.offset, text: e.text }));
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]!;
        const sub = boundSourceNesting(item.text);
        if (!('source' in sub)) {
          return { ok: false, error: nestingFailure(errorSource, { offset: item.offset + sub.offset, expected: sub.expected }) };
        }
        const subMatch = grammar.match(sub.source, 'Expr');
        if (!subMatch.succeeded()) return { ok: false, error: buildParseError(subMatch, errorSource, item.offset) };
        if (sub.elided !== undefined) {
          for (const child of sub.elided) queue.push({ offset: item.offset + child.offset, text: child.text });
        }
      }
    }
    return { ok: true, value: build(match) };
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, error: stackFailure(errorSource) };
    throw e;
  }
}

// ---- Public API ----

function checkStrictParse(input: string, startRule: string | undefined, emptyMsg: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, errors: [{ message: emptyMsg }] };
  const leadingTrimmed = input.length - input.trimStart().length;
  const errorSource = input.trimEnd();
  const matched = matchBounded(
    trimmed,
    startRule,
    (match) => {
      if (!trimmed.includes('{')) return null;
      firstCaptureRefOffset = null;
      semantics(match).toAST();
      return firstCaptureRefOffset;
    },
    errorSource,
    leadingTrimmed,
  );
  if (!matched.ok) return { valid: false, errors: [{ message: matched.error.message }], parseError: matched.error };
  if (matched.value !== null) {
    const error = failureAt(errorSource, leadingTrimmed + matched.value, "'$('", "Unexpected '{'.");
    return { valid: false, errors: [{ message: error.message }], parseError: error };
  }
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

/**
 * Parse and either return the AST or a structured failure. Use this when
 * the caller wants to surface a diagnostic; use `parseToAST` when null is
 * a sufficient signal.
 */
export function parseToASTOrError(
  input: string,
): { ok: true; ast: FirestoreRules } | { ok: false; error: ParseError } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: { line: 1, column: 1, offset: 0, expected: '', actual: '', message: 'Empty rules file' } };
  }
  // Ohm's line numbers are relative to the *trimmed* input. Shift `loc`
  // entries by the count of newlines we stripped off the front so callers
  // can compare against the original source they passed in.
  const leadingTrimmed = input.length - input.trimStart().length;
  let leadingLineOffset = 0;
  let lastLeadingNewline = -1;
  for (let i = 0; i < leadingTrimmed; i++) {
    if (input.charCodeAt(i) === 10) {
      leadingLineOffset++;
      lastLeadingNewline = i;
    }
  }
  // Expression positions are recorded against the caller's source directly.
  buildPositions = new SourcePositions(trimmed, leadingLineOffset, leadingTrimmed - lastLeadingNewline - 1);
  let built: ReturnType<typeof matchBounded<FirestoreRules>>;
  try {
    built = matchBounded(trimmed, undefined, (match) => semantics(match).toAST() as FirestoreRules, input.trimEnd(), leadingTrimmed);
  } finally {
    buildPositions = null;
  }
  if (!built.ok) return built;
  const ast = built.value;
  if (leadingLineOffset > 0) shiftAstLines(ast, leadingLineOffset);
  return { ok: true, ast };
}

function shiftSourceLoc(loc: { line: number; col: number; file?: string } | undefined, offset: number): void {
  if (loc !== undefined) loc.line += offset;
}

function shiftFunctionLocs(fn: FunctionDef, offset: number): void {
  shiftSourceLoc(fn.loc, offset);
  for (const binding of fn.lets) {
    shiftSourceLoc(binding.loc, offset);
    shiftSourceLoc(binding.value.loc, offset);
  }
  shiftSourceLoc(fn.body.loc, offset);
  shiftSourceLoc(fn.returnLoc, offset);
}

function shiftAstLines(ast: FirestoreRules, offset: number): void {
  shiftSourceLoc(ast.loc, offset);
  for (const imp of ast.imports) shiftSourceLoc(imp.loc, offset);
  for (const fn of ast.functions ?? []) shiftFunctionLocs(fn, offset);
  shiftSourceLoc(ast.service.loc, offset);
  for (const fn of ast.service.functions ?? []) shiftFunctionLocs(fn, offset);
  const stack: MatchBlock[] = [ast.service.match];
  while (stack.length > 0) {
    const block = stack.pop()!;
    shiftSourceLoc(block.loc, offset);
    for (const fn of block.functions) shiftFunctionLocs(fn, offset);
    for (const allow of block.allows) {
      shiftSourceLoc(allow.loc, offset);
      shiftSourceLoc(allow.condition.loc, offset);
    }
    for (const child of block.children) stack.push(child);
  }
}

function attachFunctionSourceFile(fn: FunctionDef, file: string): void {
  if (fn.loc !== undefined) fn.loc.file = file;
  for (const binding of fn.lets) {
    if (binding.loc !== undefined) binding.loc.file = file;
    if (binding.value.loc !== undefined) binding.value.loc.file = file;
  }
  if (fn.returnLoc !== undefined) fn.returnLoc.file = file;
  if (fn.body.loc !== undefined) fn.body.loc.file = file;
}

export function parseFunctions(input: string, sourceFile?: string): FunctionDef[] | null {
  const wrapped = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n${input}\n  }\n}`;
  const ast = parseToAST(wrapped);
  if (ast === null) return null;
  const fns = ast.service.match.functions;
  for (const fn of fns) {
    shiftFunctionLocs(fn, -3);
    if (sourceFile !== undefined) attachFunctionSourceFile(fn, sourceFile);
  }
  return fns;
}

