/**
 * The source position of each parsed expression node, keyed by node. The
 * AST carries positions only on declarations and allow rules, but production
 * reports an evaluation error, and the request that reaches the
 * 1000-expression limit, at the line and column of the expression it was
 * evaluating. A side table keeps the AST shape unchanged.
 *
 * Positions follow production's reports in the expression-cost capture
 * (`test/rules/linter/fixtures/expression-cost/captures.json`): a binary
 * operator is reported at its operator (`[a] + b` at the `+`), a member
 * access at the start of the whole chain (`resource.data.missing` at the
 * `r`). Every other node is placed at its first character.
 *
 * A `&&` has a second position. Production reports a limit reached while it
 * evaluates the right operand at the operator, and a limit reached as the
 * conjunction completes at the start of its source text, its opening
 * parenthesis included: `(a && b)` at the `(` (the limit-position capture in
 * `captures.json`). `completionPosition` returns that start.
 */

/** A 1-based line and column in the parsed source. */
export interface ExpressionPosition {
  line: number;
  column: number;
}

const POSITIONS = new WeakMap<object, ExpressionPosition>();

/** Where `expr` sits in the source it was parsed from, when the parser recorded it. */
export function expressionPosition(expr: object): ExpressionPosition | undefined {
  return POSITIONS.get(expr);
}

/** Records where `expr` sits in its source. */
export function setExpressionPosition(expr: object, position: ExpressionPosition): void {
  POSITIONS.set(expr, position);
}

const COMPLETIONS = new WeakMap<object, ExpressionPosition>();

/** Where production reports a limit reached as `expr` completes: its position, except for a `&&`. */
export function completionPosition(expr: object): ExpressionPosition | undefined {
  return COMPLETIONS.get(expr) ?? POSITIONS.get(expr);
}

/** Records where production reports a limit reached as `expr` completes, when that differs from its position. */
export function setCompletionPosition(expr: object, position: ExpressionPosition): void {
  COMPLETIONS.set(expr, position);
}

/** Gives `to` the positions recorded for `from`, for a converted copy of a parsed node. */
export function copyExpressionPosition(from: object, to: object): void {
  const position = POSITIONS.get(from);
  if (position !== undefined) POSITIONS.set(to, position);
  const completion = COMPLETIONS.get(from);
  if (completion !== undefined) COMPLETIONS.set(to, completion);
}

/** `line L, column C`, the way a denial reason cites a position. */
export function describeExpressionPosition(position: ExpressionPosition): string {
  return `line ${position.line}, column ${position.column}`;
}

/**
 * Converts offsets in the text the parser matched to lines and columns of
 * the source the caller passed, which may carry leading whitespace the
 * parser did not see.
 */
export class SourcePositions {
  private readonly lineStarts: number[] = [0];

  /**
   * @param matched the text the parser matched.
   * @param lineOffset newlines stripped before `matched` in the caller's source.
   * @param firstLineColumnOffset characters stripped before `matched` on its first line.
   */
  constructor(
    matched: string,
    private readonly lineOffset: number,
    private readonly firstLineColumnOffset: number,
  ) {
    for (let i = 0; i < matched.length; i++) {
      if (matched.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  at(offset: number): ExpressionPosition {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    const column = offset - this.lineStarts[low]! + 1;
    return {
      line: low + 1 + this.lineOffset,
      column: low === 0 ? column + this.firstLineColumnOffset : column,
    };
  }
}
