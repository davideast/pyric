/**
 * Per-request expression budget, counted in production's unit.
 *
 * Production lets a Security Rules request evaluate 1000 expressions and
 * denies it at the next one, with "Unable to evaluate the expression as the
 * maximum of 1000 expressions to evaluate has been reached." The limit
 * belongs to the request: allow rules for the request's method run in source
 * order until one grants, and every rule evaluated on the way counts.
 *
 * The unit is the one measured against production and recorded in
 * `test/rules/linter/LINTER_SPEC.md` (EXPRESSION_BUDGET) and
 * `src/rules/linter/expression-cost.ts`, which estimates the same count
 * statically:
 *
 *  - every evaluated expression node costs 1, literals included;
 *  - `&&` and `||` cost 1 more when they evaluate their right operand;
 *  - a ternary costs 1 more, and 2 more again when it takes the false
 *    branch (measured on the chess promotion and the reversi rows; the
 *    ladder measured only the true branch);
 *  - a path literal costs 1 more per literal segment;
 *  - a `let` binding costs 1 plus its value, on every call.
 *
 * The evaluators charge through the named methods below, so the unit lives
 * here once. The budget does not format or record expressions; it only
 * counts.
 */
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';

export { EXPRESSION_LIMIT };

/** Production's message for a request that reaches the limit. */
export const EXPRESSION_LIMIT_MESSAGE =
  `Unable to evaluate the expression as the maximum of ${EXPRESSION_LIMIT} expressions to evaluate has been reached.`;

export class ExpressionBudget {
  /** Expressions evaluated so far for this request, in production's unit. */
  evaluated = 0;

  /**
   * @param exhausted builds the error thrown when the request would
   *   evaluate past the limit. Each evaluator supplies its own resource-limit error class, so
   *   the limit fails the whole request closed and no `&&` or `||` operand
   *   absorbs it.
   */
  constructor(
    private readonly exhausted: (message: string) => Error,
    readonly limit: number = EXPRESSION_LIMIT,
  ) {}

  /** One evaluated expression node. */
  node(): void {
    this.charge();
  }

  /** The second unit `&&` or `||` pays when it evaluates its right operand. */
  logicalRight(): void {
    this.charge();
  }

  /** The second unit a ternary pays, charged before its condition. */
  ternary(): void {
    this.charge();
  }

  /** The two further units a ternary pays when it takes the false branch. */
  ternaryElse(): void {
    this.charge();
    this.charge();
  }

  /** One literal segment of a path literal. */
  pathSegment(): void {
    this.charge();
  }

  /** One `let` binding, charged before its value is evaluated. */
  letBinding(): void {
    this.charge();
  }

  private charge(): void {
    // A request may evaluate `limit` expressions; the next one stops it.
    if (this.evaluated >= this.limit) throw this.exhausted(EXPRESSION_LIMIT_MESSAGE);
    this.evaluated++;
  }
}
