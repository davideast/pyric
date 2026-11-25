/**
 * Evaluate a pre-validated condition expression against a token's topic set.
 * Uses the same boolean grammar as `parseCondition` in `./validate.js`.
 */
export function evaluateCondition(condition: string, topics: ReadonlySet<string>): boolean {
  const src = condition;
  let pos = 0;

  function ws(): void {
    while (pos < src.length && /\s/.test(src.charAt(pos))) pos++;
  }
  function lit(s: string): boolean {
    ws();
    if (src.startsWith(s, pos)) {
      pos += s.length;
      return true;
    }
    return false;
  }
  function primary(): boolean {
    ws();
    if (lit('!')) return !primary();
    if (lit('(')) {
      const v = orExpr();
      lit(')');
      return v;
    }
    ws();
    pos++; // opening quote (validated upstream)
    const start = pos;
    while (pos < src.length && src.charAt(pos) !== "'") pos++;
    const name = src.slice(start, pos);
    pos++; // closing quote
    lit('in');
    lit('topics');
    return topics.has(name);
  }
  function andExpr(): boolean {
    let value = primary();
    for (;;) {
      ws();
      if (lit('&&')) {
        const rhs = primary();
        value = value && rhs;
        continue;
      }
      return value;
    }
  }
  function orExpr(): boolean {
    let value = andExpr();
    for (;;) {
      ws();
      if (lit('||')) {
        const rhs = andExpr();
        value = value || rhs;
        continue;
      }
      return value;
    }
  }
  return orExpr();
}
