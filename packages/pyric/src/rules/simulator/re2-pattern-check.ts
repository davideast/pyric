/**
 * The one check Firestore and Storage run on a regex literal at compile
 * time: production refuses a pattern RE2 cannot compile when the ruleset is
 * deployed, with "Invalid regular expression pattern. Pattern: <p>.".
 *
 * A pattern is refused when RE2's parser would refuse it (a repeat count
 * over 1000), when it expands past pyric's size limits (#1264), when it uses
 * a construct RE2 lacks (backreferences, lookaround), or when it does not
 * compile at all.
 */
import { normalizeRe2ForJsRegExp } from '../grammar/re2-pattern.js';
import { invalidPatternMessage, parseRe2Ast, re2SizeRefusal } from './rules-type.js';

/** Why production would refuse `pattern` at compile, as its message, or null. */
export function re2PatternProblem(pattern: string): string | null {
  const invalid = invalidPatternMessage(pattern);
  if (/\\[1-9]/.test(pattern) || /\(\?<?[=!]/.test(pattern)) return invalid;
  try {
    const sizeRefusal = re2SizeRefusal(pattern, parseRe2Ast(pattern));
    if (sizeRefusal !== null) return sizeRefusal;
    new RegExp(`^(?:${normalizeRe2ForJsRegExp(pattern)})$`);
    return null;
  } catch {
    return invalid;
  }
}
