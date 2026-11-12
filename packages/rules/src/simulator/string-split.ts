import { CodePointSubject } from './regex-nfa.js';
import { compileRe2Search } from './rules-type.js';

/**
 * Evaluate `subject.split(pattern)` as production does, for Firestore and
 * Storage alike. The pattern gets the checks `matches()` gives it (RE2's
 * syntax, pyric's size limits) and runs on the same NFA, searched in time
 * linear in the subject, so a nested repeat such as `(a+)+b` never
 * backtracks (#1895) and `.*x|a` does not read the whole subject once per
 * match; `replaceRe2` searches the same way. The subject is read as code
 * points, as `matches()` reads it (#1890), `(?U)` makes repeats ungreedy
 * (#1891), and `\A` and `\z` stay absolute under `(?m)` (#1892). Captures
 * `c1-re2-replace-split`, `c9-re2-more` and `c10-script-classes-and-redos`
 * from the 2026-11-03 Firestore hunt observe the `split()` cases; the `(?U)`
 * and `\A`/`\z` readings are observed there through `replace()`.
 *
 * Two differences from JavaScript's `String.prototype.split`, both from the
 * Firestore Rules Test API captures `re2-pattern-semantics` and
 * `split-and-trim-edges` (rows firestore-rules#199 and #202):
 * - capture-group text is never a piece (`'a1b'.split('(1)') == ['a', 'b']`);
 * - trailing empty pieces are dropped, as Java's `String.split` does, but one
 *   piece always remains (`','.split(',') == ['']`, `'a,b,'.split(',')` has
 *   size two). A leading empty piece is kept.
 *
 * Otherwise the pieces fall where JavaScript's split puts them: after an empty
 * match at the start of a piece the search moves on one code unit, so an
 * empty pattern still splits a surrogate pair. Capture `c1-re2-replace-split`
 * (`as7`) shows production's `'a😀b'.split('')` does not have size three.
 */
export function splitRe2(subject: string, pattern: string): string[] {
  const text = new CodePointSubject(subject, compileRe2Search('split', pattern).search);
  return withoutTrailingEmptyPieces(splitPieces(text));
}

/** JavaScript's split algorithm, with each match found by one linear search. */
function splitPieces(text: CodePointSubject): string[] {
  const subject = text.text;
  const size = subject.length;
  if (size === 0) return text.find(0) === null ? [''] : [];
  const pieces: string[] = [];
  let pieceStart = 0;
  let from = 0;
  while (from < size) {
    const span = text.find(from);
    if (span === null || span.start >= size) break;
    const emptyAtPieceStart = span.end === pieceStart;
    if (emptyAtPieceStart) {
      from = span.start + 1;
      continue;
    }
    pieces.push(subject.slice(pieceStart, span.start));
    pieceStart = span.end;
    from = pieceStart;
  }
  pieces.push(subject.slice(pieceStart));
  return pieces;
}

function withoutTrailingEmptyPieces(pieces: string[]): string[] {
  let end = pieces.length;
  while (end > 1 && pieces[end - 1] === '') end -= 1;
  return pieces.slice(0, end);
}
