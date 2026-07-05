/**
 * Item 4.1.3 — Recursive-descent parser for the transaction-tool
 * expression language.
 *
 * `parse(tokens)` consumes a token stream from `tokenize()` and returns
 * a single `AstNode` representing the whole expression. The parser
 * implements the corrected grammar (see types.ts header for the four
 * supersedence corrections):
 *
 *   Expression  = Ternary
 *   Ternary     = LogicalOr ( "?" Expression ":" Expression )?
 *   LogicalOr   = LogicalAnd ( "||" LogicalAnd )*
 *   LogicalAnd  = Comparison ( "&&" Comparison )*
 *   Comparison  = Sum ( ("==" | "!=" | "<" | "<=" | ">" | ">=") Sum )*
 *   Sum         = Product ( ("+" | "-") Product )*
 *   Product     = Unary ( ("*" | "/" | "%") Unary )*
 *   Unary       = ("-" | "!") Unary | Postfix
 *   Postfix     = Primary ("." Identifier | "[" Expression "]")*
 *   Primary     = Number | String | Boolean | Null
 *               | Reference | SentinelCall | "(" Expression ")"
 *
 * Defensive choices, mirrored from the pre-mortem:
 *  - Comparison and arithmetic chains are LEFT-associative; ternary is
 *    RIGHT-associative. Both are tested explicitly so a future refactor
 *    can't silently flip them.
 *  - `&&` and `||` are SPLIT into LogicalAnd / LogicalOr so `a || b && c`
 *    parses as `a || (b && c)` (mainstream-language convention, matches
 *    Firestore Rules).
 *  - Sentinels MUST have a name on the whitelist, MUST have parens, and
 *    MUST satisfy arity at parse time. Failure is a loud
 *    `ExpressionParseError` before evaluation begins.
 *  - AST depth (root-to-leaf, counting every node) is enforced after
 *    parsing in a single O(n) walk. The 256-char source cap bounds the
 *    AST size globally, so the depth check is correctness-only, not a
 *    DoS gate.
 */

import {
  EXPRESSION_LIMITS,
  ExpressionParseError,
  isSentinelName,
  SENTINEL_ARITY,
  type AstNode,
  type BinaryOp,
  type Position,
  type SentinelName,
  type Token,
  type TokenKind,
} from './types.js';

export function parse(tokens: Token[]): AstNode {
  const p = new Parser(tokens);
  const node = p.parseExpression();
  p.expect('eof', 'unexpected trailing tokens');
  enforceDepthCap(node);
  return node;
}

class Parser {
  private cursor = 0;
  constructor(private readonly tokens: Token[]) {}

  // ----- top of the grammar -----

  parseExpression(): AstNode {
    return this.parseTernary();
  }

  /**
   * Ternary is RIGHT-associative: `a ? b : c ? d : e` → `a ? b : (c ? d : e)`.
   * Both branches are full Expressions, so the recursion is natural.
   */
  private parseTernary(): AstNode {
    const cond = this.parseLogicalOr();
    if (this.peek().kind !== 'question') return cond;
    const q = this.consume();
    const whenTrue = this.parseExpression();
    this.expect('colon', `expected ':' in ternary`);
    const whenFalse = this.parseExpression();
    return {
      kind: 'ternary',
      cond,
      whenTrue,
      whenFalse,
      pos: q.pos,
    };
  }

  /**
   * LogicalOr — split out from LogicalAnd so `||` binds LOOSER than `&&`.
   * `a && b || c && d` parses as `(a && b) || (c && d)`.
   */
  private parseLogicalOr(): AstNode {
    let left = this.parseLogicalAnd();
    while (this.peek().kind === 'or') {
      const op = this.consume();
      const right = this.parseLogicalAnd();
      left = { kind: 'logical', op: '||', left, right, pos: op.pos };
    }
    return left;
  }

  private parseLogicalAnd(): AstNode {
    let left = this.parseComparison();
    while (this.peek().kind === 'and') {
      const op = this.consume();
      const right = this.parseComparison();
      left = { kind: 'logical', op: '&&', left, right, pos: op.pos };
    }
    return left;
  }

  /**
   * Comparison chains are syntactically allowed (`1 < 2 < 3` parses)
   * but semantically nonsense — `(1 < 2) < 3` evaluates `bool < number`,
   * which the strict-typing evaluator rejects. Loud at eval, not parse.
   */
  private parseComparison(): AstNode {
    let left = this.parseSum();
    while (true) {
      const op = comparisonOp(this.peek().kind);
      if (!op) break;
      const tok = this.consume();
      const right = this.parseSum();
      left = { kind: 'binary', op, left, right, pos: tok.pos };
    }
    return left;
  }

  private parseSum(): AstNode {
    let left = this.parseProduct();
    while (true) {
      const k = this.peek().kind;
      if (k !== 'plus' && k !== 'minus') break;
      const tok = this.consume();
      const right = this.parseProduct();
      const op: BinaryOp = k === 'plus' ? '+' : '-';
      left = { kind: 'binary', op, left, right, pos: tok.pos };
    }
    return left;
  }

  private parseProduct(): AstNode {
    let left = this.parseUnary();
    while (true) {
      const k = this.peek().kind;
      if (k !== 'star' && k !== 'slash' && k !== 'percent') break;
      const tok = this.consume();
      const right = this.parseUnary();
      const op: BinaryOp = k === 'star' ? '*' : k === 'slash' ? '/' : '%';
      left = { kind: 'binary', op, left, right, pos: tok.pos };
    }
    return left;
  }

  private parseUnary(): AstNode {
    const k = this.peek().kind;
    if (k === 'minus' || k === 'bang') {
      const tok = this.consume();
      const operand = this.parseUnary();
      return {
        kind: 'unary',
        op: k === 'minus' ? '-' : '!',
        operand,
        pos: tok.pos,
      };
    }
    return this.parsePostfix();
  }

  /**
   * Postfix: dot-access and bracket-access chain on any Primary.
   * `$a.b[0].c["k"]` is a four-link chain.
   */
  private parsePostfix(): AstNode {
    let target = this.parsePrimary();
    while (true) {
      const k = this.peek().kind;
      if (k === 'dot') {
        const tok = this.consume();
        const ident = this.expect('identifier', `expected identifier after '.'`);
        target = {
          kind: 'fieldAccess',
          target,
          field: ident.value as string,
          pos: tok.pos,
        };
      } else if (k === 'lbracket') {
        const tok = this.consume();
        const index = this.parseExpression();
        this.expect('rbracket', `expected ']'`);
        target = { kind: 'indexAccess', target, index, pos: tok.pos };
      } else {
        break;
      }
    }
    return target;
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();
    switch (tok.kind) {
      case 'number':
        this.consume();
        return { kind: 'literal', value: tok.value as number, pos: tok.pos };
      case 'string':
        this.consume();
        return { kind: 'literal', value: tok.value as string, pos: tok.pos };
      case 'true':
        this.consume();
        return { kind: 'literal', value: true, pos: tok.pos };
      case 'false':
        this.consume();
        return { kind: 'literal', value: false, pos: tok.pos };
      case 'null':
        this.consume();
        return { kind: 'literal', value: null, pos: tok.pos };
      case 'reference':
        this.consume();
        return { kind: 'reference', alias: tok.value as string, pos: tok.pos };
      case 'sentinel':
        return this.parseSentinelCall();
      case 'lparen': {
        this.consume();
        const inner = this.parseExpression();
        this.expect('rparen', `expected ')'`);
        return inner;
      }
      case 'identifier':
        // Bare identifiers are not values in this grammar. Common
        // typo pattern: writing `increment(1)` instead of `@increment(1)`.
        throw new ExpressionParseError(
          `bare identifier '${tok.value}' is not a value (did you mean '$${tok.value}' or '@${tok.value}'?)`,
          tok.pos,
        );
      case 'eof':
        throw new ExpressionParseError(
          `unexpected end of expression`,
          tok.pos,
        );
      default:
        throw new ExpressionParseError(
          `unexpected token`,
          tok.pos,
        );
    }
  }

  private parseSentinelCall(): AstNode {
    const tok = this.consume();
    const name = tok.value as string;
    if (!isSentinelName(name)) {
      throw new ExpressionParseError(
        `unknown sentinel '@${name}' (allowed: serverTimestamp, increment, arrayUnion, arrayRemove, deleteField)`,
        tok.pos,
      );
    }
    // Parens REQUIRED — see Q3 sign-off in the design doc.
    this.expect('lparen', `expected '(' after sentinel '@${name}'`);
    const args: AstNode[] = [];
    if (this.peek().kind !== 'rparen') {
      args.push(this.parseExpression());
      while (this.peek().kind === 'comma') {
        this.consume();
        args.push(this.parseExpression());
      }
    }
    this.expect('rparen', `expected ')' after sentinel arguments`);
    const arity = SENTINEL_ARITY[name as SentinelName];
    if (args.length < arity.min || args.length > arity.max) {
      const expectStr = arity.max === Infinity
        ? `at least ${arity.min}`
        : arity.min === arity.max
          ? `exactly ${arity.min}`
          : `${arity.min}..${arity.max}`;
      throw new ExpressionParseError(
        `sentinel '@${name}' expects ${expectStr} argument(s), got ${args.length}`,
        tok.pos,
      );
    }
    return { kind: 'sentinel', name: name as SentinelName, args, pos: tok.pos };
  }

  // ----- token-stream primitives -----

  private peek(): Token {
    return this.tokens[this.cursor]!;
  }

  private consume(): Token {
    const t = this.tokens[this.cursor]!;
    this.cursor += 1;
    return t;
  }

  expect(kind: TokenKind, message: string): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new ExpressionParseError(
        `${message} (got ${describeToken(t)})`,
        t.pos,
      );
    }
    return this.consume();
  }
}

function comparisonOp(kind: TokenKind): BinaryOp | null {
  switch (kind) {
    case 'eq': return '==';
    case 'neq': return '!=';
    case 'lt': return '<';
    case 'lte': return '<=';
    case 'gt': return '>';
    case 'gte': return '>=';
    default: return null;
  }
}

function describeToken(t: Token): string {
  if (t.kind === 'eof') return 'end of expression';
  if (t.value !== undefined) return `${t.kind} ${JSON.stringify(t.value)}`;
  return t.kind;
}

/**
 * Walk the AST once, checking that no root-to-leaf path exceeds the
 * depth cap. We compute depth bottom-up; if any node's max child depth
 * + 1 would exceed the cap, throw at that node's position.
 */
function enforceDepthCap(root: AstNode): void {
  walk(root);
  function walk(n: AstNode): number {
    let childDepth = 0;
    switch (n.kind) {
      case 'literal':
      case 'reference':
        childDepth = 0;
        break;
      case 'unary':
        childDepth = walk(n.operand);
        break;
      case 'binary':
      case 'logical':
        childDepth = Math.max(walk(n.left), walk(n.right));
        break;
      case 'ternary':
        childDepth = Math.max(
          walk(n.cond),
          walk(n.whenTrue),
          walk(n.whenFalse),
        );
        break;
      case 'fieldAccess':
        childDepth = walk(n.target);
        break;
      case 'indexAccess':
        childDepth = Math.max(walk(n.target), walk(n.index));
        break;
      case 'sentinel':
        childDepth = n.args.length === 0
          ? 0
          : Math.max(...n.args.map(walk));
        break;
    }
    const depth = childDepth + 1;
    if (depth > EXPRESSION_LIMITS.maxAstDepth) {
      throw new ExpressionParseError(
        `expression AST exceeds depth cap of ${EXPRESSION_LIMITS.maxAstDepth}`,
        (n as { pos: Position }).pos,
      );
    }
    return depth;
  }
}
