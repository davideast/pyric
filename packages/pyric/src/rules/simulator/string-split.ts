import { re2RepeatGreediness, scanRe2Pattern } from '../grammar/re2-pattern.js';
import {
  compileRegexSearch,
  withRepeatGreediness,
  type LeadUnit,
  type RegexPosition,
  type RegexSearch,
  type RegexSpan,
} from './regex-nfa.js';
import { parseRe2Ast, re2PatternCompiles, re2SizeRefusal } from './rules-type.js';

/**
 * Evaluate `subject.split(pattern)` as production does, for Firestore and
 * Storage alike. The pattern gets the checks `matches()` gives it (RE2's
 * syntax, pyric's size limits) and runs on the same NFA, searched in time
 * linear in the subject per match found, so a nested repeat such as `(a+)+b`
 * never backtracks (#1895). The subject is read as code points, as
 * `matches()` reads it (#1890), `(?U)` makes repeats ungreedy (#1891), and
 * `\A` and `\z` stay absolute under `(?m)` (#1892). Captures
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
  const text = new SplitSubject(subject, compileSplitPattern(pattern));
  return withoutTrailingEmptyPieces(text.pieces());
}

function compileSplitPattern(pattern: string): RegexSearch {
  const { unsupported } = scanRe2Pattern(pattern);
  if (unsupported !== null) {
    throw new Error(`split() pattern uses an RE2-unsupported construct (${unsupported}) that production would reject`);
  }
  if (!re2PatternCompiles(pattern)) throw new Error(`Invalid regex '${pattern}' in split()`);
  const ast = parseRe2Ast(pattern);
  const sizeRefusal = re2SizeRefusal(pattern, ast);
  if (sizeRefusal !== null) throw new Error(sizeRefusal);
  return compileRegexSearch(withRepeatGreediness(ast, re2RepeatGreediness(pattern)));
}

interface UnitSpan {
  start: number;
  end: number;
}

/** A subject read as code points, searched and cut at code-unit offsets. */
class SplitSubject {
  private readonly chars: string[];
  /** The code-unit offset where each code point starts, and the subject's length. */
  private readonly offsets: number[];
  /** For each code-unit offset, the code point starting there, or -1 inside a pair. */
  private readonly charAt: Int32Array;

  constructor(
    private readonly subject: string,
    private readonly search: RegexSearch,
  ) {
    this.chars = Array.from(subject);
    this.offsets = [];
    this.charAt = new Int32Array(subject.length + 1).fill(-1);
    let offset = 0;
    this.chars.forEach((ch, index) => {
      this.offsets.push(offset);
      this.charAt[offset] = index;
      offset += ch.length;
    });
    this.offsets.push(offset);
    this.charAt[offset] = this.chars.length;
  }

  /** JavaScript's split algorithm, with each match found by one linear search. */
  pieces(): string[] {
    const size = this.subject.length;
    if (size === 0) return this.find(0) === null ? [''] : [];
    const pieces: string[] = [];
    let pieceStart = 0;
    let from = 0;
    while (from < size) {
      const span = this.find(from);
      if (span === null || span.start >= size) break;
      const emptyAtPieceStart = span.end === pieceStart;
      if (emptyAtPieceStart) {
        from = span.start + 1;
        continue;
      }
      pieces.push(this.subject.slice(pieceStart, span.start));
      pieceStart = span.end;
      from = pieceStart;
    }
    pieces.push(this.subject.slice(pieceStart));
    return pieces;
  }

  /** The leftmost match at or after code-unit offset `from`, in code-unit offsets. */
  private find(from: number): UnitSpan | null {
    const index = this.charAt[from]!;
    if (index >= 0) return this.toUnits(this.search(this.chars, index), from);
    // `from` is the low half of the pair before the next code point.
    const next = this.charAt[from + 1]!;
    const pair = this.subject.slice(from - 1, from + 1);
    const lead: LeadUnit = { unit: pair[1]!, context: [pair[0]!, pair[1]!], pos: 1 };
    return this.toUnits(this.search(this.chars, next, lead), from);
  }

  private toUnits(span: RegexSpan | null, leadOffset: number): UnitSpan | null {
    if (span === null) return null;
    const unit = (pos: RegexPosition): number => (pos === 'lead' ? leadOffset : this.offsets[pos]!);
    return { start: unit(span.start), end: unit(span.end) };
  }
}

function withoutTrailingEmptyPieces(pieces: string[]): string[] {
  let end = pieces.length;
  while (end > 1 && pieces[end - 1] === '') end -= 1;
  return pieces.slice(0, end);
}
