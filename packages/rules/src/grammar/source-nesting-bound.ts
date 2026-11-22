import { MAX_BRACKET_DEPTH, scanBrackets } from './bracket-scan.js';

/** Deepest nesting level an expression node may sit at; a node at level 100 is rejected. */
export const NESTING_LEVEL_LIMIT = 99;

/** Source the parser cannot read, with where the bracket past its bound opens. */
export interface SourceNestingFailure {
  offset: number;
  /** What the source would need instead, worded for a parse error's `expected`. */
  expected: string;
}

/** A closed bracket span whose interior was replaced to bound nesting depth. */
interface ElidedSpan {
  offset: number;
  text: string;
}

function isBlankSlice(source: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = source.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

/**
 * The source for the parser to match, with the content of every bracket
 * nested past the nesting limit replaced, or where it nests past the
 * parser's bracket depth bound.
 */
export function boundSourceNesting(
  source: string,
): { source: string; elided?: ElidedSpan[] } | SourceNestingFailure {
  const spans = scanBrackets(source, { comments: true, regexLiterals: false, multilineStrings: false });
  let rewritten: string[] | undefined;
  let elided: ElidedSpan[] | undefined;
  let emptiedUntil = -1;
  for (let idx = 0; idx < spans.length; idx++) {
    const span = spans[idx]!;
    if (span.open < emptiedUntil) continue;
    if (span.depth > MAX_BRACKET_DEPTH) {
      return { offset: span.open, expected: `brackets nested at most ${MAX_BRACKET_DEPTH} levels deep` };
    }
    if (span.levels < NESTING_LEVEL_LIMIT || span.items === 0) continue;
    const end = span.close === -1 ? source.length : span.close;
    const content = source.slice(span.open + 1, end);
    const item = span.kind === 'map' ? 'a:1' : '1';
    const replacement = Array.from({ length: span.items }, () => item).join(',');
    // Content too short for its items is malformed; the parser reports it.
    if (content.replace(/[\n\r]/g, '').length < replacement.length) continue;
    let next = 0;
    const filled = content.replace(/[^\n\r]/g, () => (next < replacement.length ? replacement[next++]! : ' '));
    rewritten ??= [];
    rewritten.push(source.slice(Math.max(emptiedUntil, 0), span.open + 1), filled);
    emptiedUntil = end === source.length ? Infinity : end;
    if (span.close !== -1) {
      let cur = idx;
      while (cur + 1 < spans.length) {
        const parent = spans[cur]!;
        const nextSpan = spans[cur + 1]!;
        const isWrapper = (parent.kind === 'group' || parent.kind === 'list') && parent.items === 1;
        const isEnclosed = nextSpan.close !== -1 && nextSpan.open > parent.open && nextSpan.close < parent.close;
        const nextValid = (nextSpan.kind === 'group' || nextSpan.kind === 'list' || nextSpan.kind === 'map') && nextSpan.items >= 1;
        if (!isWrapper || !isEnclosed || !nextValid) break;
        if (!isBlankSlice(source, parent.open + 1, nextSpan.open) || !isBlankSlice(source, nextSpan.close + 1, parent.close)) break;
        cur++;
      }
      const target = spans[cur]!;
      let text = source.slice(target.open, target.close + 1);
      if (target.kind === 'call') text = `[${source.slice(target.open + 1, target.close)}]`;
      elided ??= [];
      elided.push({ offset: target.open, text });
    }
  }
  if (rewritten === undefined) return { source };
  if (emptiedUntil !== Infinity) rewritten.push(source.slice(emptiedUntil));
  const result: { source: string; elided?: ElidedSpan[] } = { source: rewritten.join('') };
  if (elided !== undefined) {
    result.elided = elided;
  }
  return result;
}
