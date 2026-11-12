/**
 * Item 4.1.1 — AST node types, token kinds, error classes, and the
 * sentinel arity table for the `firestore_simulator_transaction` MCP
 * tool's expression language.
 *
 * The expression language is a bounded, side-effect-free arithmetic +
 * boolean DSL evaluated server-side against a captured read-set. It
 * exists so an agent can write `{ "$expr": "$src.balance - 30" }`
 * without ever seeing `$src.balance`'s value (context-cost
 * minimisation, see the design rationale).
 *
 * This module is pure types + constants — no logic. The lexer
 * (Item 4.1.2) and parser (Item 4.1.3) import from here; the
 * evaluator (Item 4.2) imports the AST shape; the tool layer
 * (Item 4.4) imports the error classes for surface-level catches.
 *
 * Four corrections to the design doc's literal EBNF live in its
 * Decisions Log; this module IS the corrected spec:
 *   1. `&&` binds tighter than `||` (split LogicalAnd / LogicalOr).
 *   2. Numeric literals are unsigned; `-` is always an operator.
 *   3. Sentinel parens are required.
 *   4. AST depth counts AST nodes, not parser recursion.
 */

// ---------------------------------------------------------------------
// Bounded-eval limits.
// Defense-in-depth caps; first hit at the tool layer (input length),
// then in the lexer (string-literal length, total token count
// derivative), then in the parser (AST depth on construction).
// ---------------------------------------------------------------------

export const EXPRESSION_LIMITS = {
  /** Max characters in the source expression. Checked BEFORE tokenising. */
  maxExpressionLength: 256,
  /** Max characters in any single string literal token. Checked at lex time. */
  maxStringLiteralLength: 1024,
  /** Max AST node depth from root. Checked during parser construction. */
  maxAstDepth: 16,
} as const;

// ---------------------------------------------------------------------
// Source positions for error pointers.
// `column` is 1-based (matches Firestore tooling conventions).
// ---------------------------------------------------------------------

export interface Position {
  /** 0-based offset into the source string. */
  offset: number;
  /** 1-based column number (we don't track lines — expressions are one-line). */
  column: number;
}

// ---------------------------------------------------------------------
// Tokens (lexer output, parser input).
// ---------------------------------------------------------------------

export type TokenKind =
  // Literals
  | 'number'
  | 'string'
  | 'true'
  | 'false'
  | 'null'
  // Identifiers and identifier-prefixed forms
  | 'identifier'   // bare identifier; only legal after `.`
  | 'reference'    // `$alias` — lexer concatenates
  | 'sentinel'     // `@name`  — lexer concatenates; parser requires `(...)` after
  // Punctuators
  | 'lparen' | 'rparen' | 'lbracket' | 'rbracket'
  | 'comma' | 'dot' | 'question' | 'colon'
  // Arithmetic / comparison / logical operators
  | 'plus' | 'minus' | 'star' | 'slash' | 'percent'
  | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'and' | 'or' | 'bang'
  // End of input
  | 'eof';

export interface Token {
  kind: TokenKind;
  pos: Position;
  /**
   * For `number`: the parsed numeric value (already validated finite +
   * within safe-integer for ints).
   * For `string`: the unescaped string contents (escapes processed).
   * For `identifier` | `reference` | `sentinel`: the identifier text
   * (without the `$` or `@` prefix).
   * For everything else: undefined.
   */
  value?: string | number;
}

// ---------------------------------------------------------------------
// AST nodes (parser output, evaluator input).
// Discriminated union keyed by `kind`. Every node carries its source
// position for runtime error pointers.
// ---------------------------------------------------------------------

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type UnaryOp = '-' | '!';
export type LogicalOp = '&&' | '||';

export type AstNode =
  | LiteralNode
  | ReferenceNode
  | SentinelNode
  | UnaryNode
  | BinaryNode
  | LogicalNode
  | TernaryNode
  | FieldAccessNode
  | IndexAccessNode;

export interface LiteralNode {
  kind: 'literal';
  value: number | string | boolean | null;
  pos: Position;
}

export interface ReferenceNode {
  kind: 'reference';
  alias: string;
  pos: Position;
}

export interface SentinelNode {
  kind: 'sentinel';
  name: SentinelName;
  args: AstNode[];
  pos: Position;
}

export interface UnaryNode {
  kind: 'unary';
  op: UnaryOp;
  operand: AstNode;
  pos: Position;
}

export interface BinaryNode {
  kind: 'binary';
  op: BinaryOp;
  left: AstNode;
  right: AstNode;
  pos: Position;
}

/**
 * Logical operators are split out from `BinaryNode` because they
 * short-circuit (eval-only concern) and because their precedence is
 * different from arithmetic comparisons. Keeping them as a distinct
 * node forces the evaluator to reach a separate handler — easy to
 * audit, hard to silently regress.
 */
export interface LogicalNode {
  kind: 'logical';
  op: LogicalOp;
  left: AstNode;
  right: AstNode;
  pos: Position;
}

export interface TernaryNode {
  kind: 'ternary';
  cond: AstNode;
  whenTrue: AstNode;
  whenFalse: AstNode;
  pos: Position;
}

export interface FieldAccessNode {
  kind: 'fieldAccess';
  target: AstNode;
  field: string;
  pos: Position;
}

export interface IndexAccessNode {
  kind: 'indexAccess';
  target: AstNode;
  index: AstNode;
  pos: Position;
}

// ---------------------------------------------------------------------
// Sentinel whitelist + arity.
// Locked in design doc (Decisions Log): five user-callable sentinels,
// 1:1 name match with `value-resolver.ts`'s registered converters.
// `Infinity` for `max` denotes variadic; the parser checks `args.length
// >= min && args.length <= max`.
// ---------------------------------------------------------------------

export const SENTINEL_NAMES = [
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
] as const;

export type SentinelName = typeof SENTINEL_NAMES[number];

export interface SentinelArity {
  min: number;
  /** `Infinity` for variadic. */
  max: number;
}

export const SENTINEL_ARITY: Record<SentinelName, SentinelArity> = {
  serverTimestamp: { min: 0, max: 0 },
  increment: { min: 1, max: 1 },
  arrayUnion: { min: 1, max: Infinity },
  arrayRemove: { min: 1, max: Infinity },
  deleteField: { min: 0, max: 0 },
};

export function isSentinelName(name: string): name is SentinelName {
  return (SENTINEL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------
// Errors.
// Two distinct classes so the tool layer can switch behaviour:
//   - LexError: produced before tokens (unterminated string, bad char).
//   - ParseError: produced from a token stream (bad shape, depth cap,
//     unknown sentinel, wrong arity, oversize expression).
// Both carry a `Position` so the response can point to the offending
// column. Both inherit a `code` matching `FIRESTORE_ERROR_CODES` so
// the tool maps them to `invalid-argument` without a separate switch.
// ---------------------------------------------------------------------

export class ExpressionLexError extends Error {
  readonly code = 'invalid-argument' as const;
  readonly pos: Position;
  constructor(message: string, pos: Position) {
    super(message);
    this.name = 'ExpressionLexError';
    this.pos = pos;
  }
}

export class ExpressionParseError extends Error {
  readonly code = 'invalid-argument' as const;
  readonly pos: Position;
  constructor(message: string, pos: Position) {
    super(message);
    this.name = 'ExpressionParseError';
    this.pos = pos;
  }
}
