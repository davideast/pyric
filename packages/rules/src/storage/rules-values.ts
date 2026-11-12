/** Error value that propagates through an expression and denies at the allow boundary. */
export class RuleError {
  constructor(readonly message: string) {}
}

export function isRuleError(value: unknown): value is RuleError {
  return value instanceof RuleError;
}
