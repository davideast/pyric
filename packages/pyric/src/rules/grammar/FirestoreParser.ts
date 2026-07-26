import * as ohm from 'ohm-js';
import { FIRESTORE_RULES_OHM_SOURCE } from './FirestoreRules.ohm.generated.js';
import type {
  FirestoreRules, ServiceBlock, MatchBlock, PathPattern, PathSegment,
  AllowRule, Operation, FunctionDef, LetBinding, Expression,
} from './FirestoreAST.js';

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
      const isFunction = ast._kind === 'function';
      if (isFunction) {
        functions.push(ast);
      } else {
        const isAllow = ast._kind === 'allow';
        if (isAllow) {
          allows.push(ast);
        } else {
          const isMatch = ast._kind === 'match';
          if (isMatch) {
            children.push(ast);
          }
        }
      }
    }
    return { functions, allows, children };
  },
  MatchBodyItem(item) { return item.toAST(); },
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
    // Source position of the `allow` keyword. Ohm's `getLineAndColumn`
    // returns 1-based line + column over the trimmed input the grammar
    // matched against (see `parseToASTOrError`, which trims before
    // matching). Trimming only strips outer whitespace, so `allow` line
    // numbers stay stable — but a caller comparing to a non-trimmed
    // source must account for any leading blank lines.
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
  Operation(op) { return op.sourceString as Operation; },
  FunctionDef(_export, _kw, name, _lp, params, _rp, _lb, body, _rb) {
    const { lets, expr } = body.toAST();
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    let isExported = false;
    const exportStr = _export.sourceString.trim();
    const isExportKw = exportStr === 'export';
    if (isExportKw) {
      isExported = true;
    }
    return {
      _kind: 'function',
      name: name.sourceString,
      parameters: params.toAST(),
      exported: isExported,
      lets,
      body: expr,
      loc: { line: lineNum, col: colNum },
    };
  },
  ParameterList(list) {
    return list.asIteration().children.map((c: any) => c.sourceString);
  },
  FunctionBody(lets, ret) {
    return { lets: lets.children.map((c: any) => c.toAST()), expr: ret.toAST() };
  },
  LetBinding(_kw, name, _eq, expr, _semi) {
    const { lineNum, colNum } = (_kw.source as any).getLineAndColumn();
    return { name: name.sourceString, value: expr.toAST(), loc: { line: lineNum, col: colNum } } as LetBinding;
  },
  ReturnStatement(_kw, expr, _semi) { return expr.toAST(); },

  // Expressions
  Expr(e) { return e.toAST(); },
  Ternary_ternary(cond, _q, cons, _colon, alt) {
    return { type: 'ternary', condition: cond.toAST(), consequent: cons.toAST(), alternate: alt.toAST() };
  },
  LogicalOr_or(left, _op, right) {
    return { type: 'binaryOp', op: '||', left: left.toAST(), right: right.toAST() };
  },
  LogicalAnd_and(left, _op, right) {
    return { type: 'binaryOp', op: '&&', left: left.toAST(), right: right.toAST() };
  },
  InIsExpr_in(left, _op, right) {
    return { type: 'inExpr', element: left.toAST(), collection: right.toAST() };
  },
  InIsExpr_is(left, _op, typeName) {
    return { type: 'isExpr', value: left.toAST(), typeName: typeName.sourceString };
  },
  Equality_eq(left, _op, right) {
    return { type: 'binaryOp', op: '==', left: left.toAST(), right: right.toAST() };
  },
  Equality_neq(left, _op, right) {
    return { type: 'binaryOp', op: '!=', left: left.toAST(), right: right.toAST() };
  },
  Comparison_gte(left, _op, right) {
    return { type: 'binaryOp', op: '>=', left: left.toAST(), right: right.toAST() };
  },
  Comparison_lte(left, _op, right) {
    return { type: 'binaryOp', op: '<=', left: left.toAST(), right: right.toAST() };
  },
  Comparison_gt(left, _op, right) {
    return { type: 'binaryOp', op: '>', left: left.toAST(), right: right.toAST() };
  },
  Comparison_lt(left, _op, right) {
    return { type: 'binaryOp', op: '<', left: left.toAST(), right: right.toAST() };
  },
  Additive_add(left, _op, right) {
    return { type: 'binaryOp', op: '+', left: left.toAST(), right: right.toAST() };
  },
  Additive_sub(left, _op, right) {
    return { type: 'binaryOp', op: '-', left: left.toAST(), right: right.toAST() };
  },
  Multiplicative_mul(left, _op, right) {
    return { type: 'binaryOp', op: '*', left: left.toAST(), right: right.toAST() };
  },
  Multiplicative_div(left, _op, right) {
    return { type: 'binaryOp', op: '/', left: left.toAST(), right: right.toAST() };
  },
  Multiplicative_mod(left, _op, right) {
    return { type: 'binaryOp', op: '%', left: left.toAST(), right: right.toAST() };
  },
  UnaryExpr_not(_op, expr) {
    return { type: 'unaryOp', op: '!', operand: expr.toAST() };
  },
  UnaryExpr_neg(_op, expr) {
    return { type: 'unaryOp', op: '-', operand: expr.toAST() };
  },
  PostfixExpr_methodCall(obj, _dot, method, _lp, args, _rp) {
    return { type: 'methodCall', object: obj.toAST(), method: method.sourceString, args: args.asIteration().children.map((c: any) => c.toAST()) };
  },
  PostfixExpr_memberAccess(obj, _dot, member) {
    return { type: 'memberAccess', object: obj.toAST(), property: member.sourceString };
  },
  PostfixExpr_bracketAccess(obj, _lb, idx, _rb) {
    return { type: 'bracketAccess', object: obj.toAST(), index: idx.toAST() };
  },
  PostfixExpr_sliceAccess(obj, _lb, start, _colon, end, _rb) {
    return { type: 'sliceAccess', object: obj.toAST(), start: start.toAST(), end: end.toAST() };
  },
  Primary_paren(_lp, expr, _rp) { return expr.toAST(); },
  Primary_path(p) { return p.toAST(); },
  Primary_list(l) { return l.toAST(); },
  Primary_map(m) { return m.toAST(); },
  Primary_functionCall(name, _lp, args, _rp) {
    return { type: 'functionCall', name: name.sourceString, args: args.asIteration().children.map((c: any) => c.toAST()) };
  },
  PathLiteral(_slash, first, _slashes, rest) {
    const segments: Array<string | Expression> = [first.toAST()];
    for (const r of rest.children) segments.push(r.toAST());
    return { type: 'pathLiteral', raw: this.sourceString, segments };
  },
  PathLitSegment_interpolation(_dp, expr, _rp) { return expr.toAST(); },
  // Match-style `{ident}` is INVALID syntax inside path literals — Firestore
  // requires `$(ident)` for interpolation. We parse it anyway (instead of
  // letting it fall through to MapLiteral and produce an opaque "expected ':'"
  // error) so the linter can emit a precise INVALID_PATH_INTERPOLATION
  // diagnostic. The braces are preserved in the segment string so the linter
  // can detect it via prefix check (legitimate pathIdent segments cannot
  // start with '{').
  PathLitSegment_captureRef(_lb, name, _rb) { return `{${name.sourceString}}`; },
  // Parenthesized database id in a cross-service Firestore lookup path,
  // e.g. `firestore.get(/databases/(default)/documents/...)`. The parens
  // are part of the production path shape, so keep them in the segment.
  PathLitSegment_parenLiteral(_lp, name, _rp) { return `(${name.sourceString})`; },
  PathLitSegment_literal(p) { return p.sourceString; },
  ListLiteral(_lb, items, _comma, _rb) {
    return { type: 'listLiteral', elements: items.asIteration().children.map((c: any) => c.toAST()) };
  },
  MapLiteral(_lb, entries, _comma, _rb) {
    return { type: 'mapLiteral', entries: entries.asIteration().children.map((c: any) => c.toAST()) };
  },
  MapEntry(key, _colon, value) {
    return { key: key.toAST(), value: value.toAST() };
  },
  literal(l) { return l.toAST(); },
  number_float(_int, _dot, _frac) {
    return { type: 'literal', value: parseFloat(this.sourceString), raw: this.sourceString };
  },
  number_int(_digits) {
    return { type: 'literal', value: parseInt(this.sourceString, 10), raw: this.sourceString };
  },
  string_single(_q1, chars, _q2) {
    return { type: 'literal', value: processStringEscapes(chars.sourceString), raw: this.sourceString };
  },
  string_double(_q1, chars, _q2) {
    return { type: 'literal', value: processStringEscapes(chars.sourceString), raw: this.sourceString };
  },
  bool_true(_) { return { type: 'literal', value: true, raw: 'true' }; },
  bool_false(_) { return { type: 'literal', value: false, raw: 'false' }; },
  null(_) { return { type: 'literal', value: null, raw: 'null' }; },
  ident(_start, _rest) { return { type: 'identifier', name: this.sourceString }; },
  _nonterminal(...children) {
    if (children.length === 1) return children[0].toAST();
    return children.map((c: any) => c.toAST());
  },
  _terminal() { return this.sourceString; },
});

// ---- String escape processing ----
// Process standard escape sequences in string literals so the resulting
// runtime value matches what production Firestore Rules produces. The
// grammar's `stringEscapeChar` rule restricts the escape character set, so
// the `default` branch below is unreachable from a successful parse. It is
// kept as defense in depth — if grammar and parser ever drift, an unknown
// escape silently preserving the raw backslash is the safer failure mode
// than a thrown exception during AST construction.
function processStringEscapes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\' || i === raw.length - 1) {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    switch (next) {
      case '\\': out += '\\'; i++; break;
      case '\'': out += '\''; i++; break;
      case '"':  out += '"';  i++; break;
      case 'n':  out += '\n'; i++; break;
      case 'r':  out += '\r'; i++; break;
      case 't':  out += '\t'; i++; break;
      case '/':  out += '/';  i++; break;
      default:   out += c; // unreachable under current grammar
    }
  }
  return out;
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
function buildParseError(match: ohm.MatchResult, source: string): ParseError {
  const offset = (match as any).getRightmostFailurePosition?.() ?? 0;
  const expected = (match as any).getExpectedText?.() ?? '';
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
  return {
    line,
    column,
    offset,
    expected,
    actual,
    message: (match as any).message ?? 'Parse error',
  };
}

// ---- Public API ----

export function parseExpression(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, errors: [{ message: 'Empty expression' }] };
  const match = grammar.match(trimmed, 'Expr');
  if (match.succeeded()) return { valid: true, errors: [] };
  const parseError = buildParseError(match, trimmed);
  return { valid: false, errors: [{ message: parseError.message }], parseError };
}

export function parseRulesFile(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, errors: [{ message: 'Empty rules file' }] };
  const match = grammar.match(trimmed);
  if (match.succeeded()) return { valid: true, errors: [] };
  const parseError = buildParseError(match, trimmed);
  return { valid: false, errors: [{ message: parseError.message }], parseError };
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
  const match = grammar.match(trimmed);
  if (!match.succeeded()) return { ok: false, error: buildParseError(match, trimmed) };
  const ast = semantics(match).toAST() as FirestoreRules;
  // Ohm's line numbers are relative to the *trimmed* input. Shift `loc`
  // entries by the count of newlines we stripped off the front so callers
  // can compare against the original source they passed in.
  const leadingTrimmed = input.length - input.trimStart().length;
  let leadingLineOffset = 0;
  for (let i = 0; i < leadingTrimmed; i++) {
    const isNewline = input.charCodeAt(i) === 10;
    if (isNewline) {
      leadingLineOffset++;
    }
  }
  const hasLeadingOffset = leadingLineOffset > 0;
  if (hasLeadingOffset) {
    shiftAstLines(ast, leadingLineOffset);
  }
  return { ok: true, ast };
}

function shiftSourceLoc(loc: { line: number; col: number; file?: string } | undefined, offset: number): void {
  const hasLoc = loc !== undefined;
  if (hasLoc) {
    loc!.line = loc!.line + offset;
  }
}

function shiftFunctionLocs(fn: FunctionDef, offset: number): void {
  shiftSourceLoc(fn.loc, offset);
  for (const binding of fn.lets) {
    shiftSourceLoc(binding.loc, offset);
    shiftSourceLoc(binding.value.loc, offset);
  }
  shiftSourceLoc(fn.body.loc, offset);
}

function shiftAstLines(ast: FirestoreRules, offset: number): void {
  shiftSourceLoc(ast.loc, offset);
  for (const imp of ast.imports) {
    shiftSourceLoc(imp.loc, offset);
  }
  const hasGlobalFunctions = ast.functions !== undefined;
  if (hasGlobalFunctions) {
    for (const fn of ast.functions!) {
      shiftFunctionLocs(fn, offset);
    }
  }
  shiftSourceLoc(ast.service.loc, offset);
  const hasServiceFunctions = ast.service.functions !== undefined;
  if (hasServiceFunctions) {
    for (const fn of ast.service.functions!) {
      shiftFunctionLocs(fn, offset);
    }
  }
  const stack: MatchBlock[] = [ast.service.match];
  let stackLen = stack.length;
  while (stackLen > 0) {
    const block = stack.pop()!;
    shiftSourceLoc(block.loc, offset);
    for (const fn of block.functions) {
      shiftFunctionLocs(fn, offset);
    }
    for (const allow of block.allows) {
      shiftSourceLoc(allow.loc, offset);
      shiftSourceLoc(allow.condition.loc, offset);
    }
    for (const child of block.children) {
      stack.push(child);
    }
    stackLen = stack.length;
  }
}

function attachFunctionSourceFile(fn: FunctionDef, file: string): void {
  const hasLoc = fn.loc !== undefined;
  if (hasLoc) {
    fn.loc!.file = file;
  }
  for (const binding of fn.lets) {
    const hasBindingLoc = binding.loc !== undefined;
    if (hasBindingLoc) {
      binding.loc!.file = file;
    }
    const hasValueLoc = binding.value.loc !== undefined;
    if (hasValueLoc) {
      binding.value.loc!.file = file;
    }
  }
  const hasBodyLoc = fn.body.loc !== undefined;
  if (hasBodyLoc) {
    fn.body.loc!.file = file;
  }
}

export function parseFunctions(input: string, sourceFile?: string): FunctionDef[] | null {
  const wrapped = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n${input}\n  }\n}`;
  const ast = parseToAST(wrapped);
  const isAstNull = ast === null;
  if (isAstNull) {
    return null;
  }
  const fns = ast!.service.match.functions;
  for (const fn of fns) {
    shiftFunctionLocs(fn, -3);
    const hasSourceFile = sourceFile !== undefined;
    if (hasSourceFile) {
      attachFunctionSourceFile(fn, sourceFile!);
    }
  }
  return fns;
}

