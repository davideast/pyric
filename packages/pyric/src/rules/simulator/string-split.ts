import { compileRe2Regex, re2CaptureGroupCount } from './rules-type.js';

/**
 * Evaluate `subject.split(pattern)` as production does, for Firestore and
 * Storage alike. The pattern compiles through `compileRe2Regex`, so it gets
 * RE2's syntax checks, inline flags and pyric's size limits.
 *
 * Two differences from JavaScript's `String.prototype.split`, both from the
 * Firestore Rules Test API captures `re2-pattern-semantics` and
 * `split-and-trim-edges` (rows firestore-rules#199 and #202):
 * - capture-group text is never a piece (`'a1b'.split('(1)') == ['a', 'b']`);
 * - trailing empty pieces are dropped, as Java's `String.split` does, but one
 *   piece always remains (`','.split(',') == ['']`, `'a,b,'.split(',')` has
 *   size two). A leading empty piece is kept.
 */
export function splitRe2(subject: string, pattern: string): string[] {
  const regex = compileRe2Regex('split', pattern, pattern, 'g');
  // JavaScript puts each match's groups between the pieces around it.
  const stride = re2CaptureGroupCount(regex) + 1;
  const pieces = subject.split(regex).filter((_, index) => index % stride === 0);
  return withoutTrailingEmptyPieces(pieces);
}

function withoutTrailingEmptyPieces(pieces: string[]): string[] {
  let end = pieces.length;
  while (end > 1 && pieces[end - 1] === '') end -= 1;
  return pieces.slice(0, end);
}
