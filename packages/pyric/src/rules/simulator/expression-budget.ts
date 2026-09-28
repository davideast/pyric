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
 *  - a `let` binding costs 1 plus its value, on every call;
 *  - an operand that errors does not stop the expression around it: the
 *    other operands, elements, receiver and arguments evaluate and count;
 *  - a namespace call (`math.pow()`) costs 1 more than a method call on a
 *    value, charged once its arguments evaluate without an error.
 *
 * The evaluators charge through the named methods below, so the unit lives
 * here once, each charge naming the expression it is for. The budget does
 * not format or record expressions; it counts, and when a charge reaches the
 * limit it hands that expression's source position to the error, the
 * position production reports the limit at.
 */
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import {
  describeExpressionPosition,
  expressionPosition,
  type ExpressionPosition,
} from '../grammar/expression-positions.js';

export { EXPRESSION_LIMIT };

/** Production's message for a request that reaches the limit. */
export const EXPRESSION_LIMIT_MESSAGE =
  `Unable to evaluate the expression as the maximum of ${EXPRESSION_LIMIT} expressions to evaluate has been reached.`;

/**
 * Production's message for a request that reached the limit, preceded by
 * where the budget ran out when that position is known:
 * `line 135, column 1790: Unable to evaluate ...`.
 */
export function describeExpressionLimit(message: string, position: ExpressionPosition | undefined): string {
  return position === undefined ? message : `${describeExpressionPosition(position)}: ${message}`;
}

export class ExpressionBudget {
  /** Expressions evaluated so far for this request, in production's unit. */
  evaluated = 0;

  /**
   * @param exhausted builds the error thrown when the request would
   *   evaluate past the limit, given the source position of the expression
   *   the budget ran out on. Each evaluator supplies its own resource-limit
   *   error class, so the limit fails the whole request closed and no `&&`
   *   or `||` operand absorbs it.
   */
  constructor(
    private readonly exhausted: (message: string, position: ExpressionPosition | undefined) => Error,
    readonly limit: number = EXPRESSION_LIMIT,
  ) {}

  /** One evaluated expression node. */
  node(at?: object): void {
    this.charge(at);
  }

  /** The second unit `&&` or `||` pays when it evaluates its right operand. */
  logicalRight(at?: object): void {
    this.charge(at);
  }

  /** The second unit a ternary pays, charged before its condition. */
  ternary(at?: object): void {
    this.charge(at);
  }

  /** The two further units a ternary pays when it takes the false branch. */
  ternaryElse(at?: object): void {
    this.charge(at);
    this.charge(at);
  }

  /** One literal segment of a path literal. */
  pathSegment(at?: object): void {
    this.charge(at);
  }

  /** One `let` binding, charged before its value is evaluated; `at` is the value. */
  letBinding(at?: object): void {
    this.charge(at);
  }

  /** @param at the parsed expression the unit is for, whose position a limit reports. */
  private charge(at: object | undefined): void {
    // A request may evaluate `limit` expressions; the next one stops it.
    if (this.evaluated >= this.limit) {
      throw this.exhausted(EXPRESSION_LIMIT_MESSAGE, at === undefined ? undefined : expressionPosition(at));
    }
    this.evaluated++;
  }
}
