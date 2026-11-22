import type * as ohm from 'ohm-js';
import { MAX_BRACKET_DEPTH } from './bracket-scan.js';
import type { SourceNestingFailure } from './compile-limits.js';
import type { FirestoreRules, FunctionDef, MatchBlock, ServiceBlock } from './FirestoreAST.js';

/**
 * Structured parse failure. Carries enough information for a caller to
 * surface a useful diagnostic without re-parsing or string-scraping.
 *
 * - `line` / `column` are 1-based.
 * - `offset` is the byte offset into the trimmed source where parsing failed.
 * - `expected` is what the grammar wanted next (e.g. ")" or "an identifier").
 * - `actual` is a short snippet from the source at the failure point.
 * - `message` is the human-readable ohm message (multi-line, includes a caret).
 */
export interface ParseError {
  line: number;
  column: number;
  offset: number;
  expected: string;
  actual: string;
  message: string;
}

export function buildParseError(match: ohm.MatchResult, source: string, baseOffset = 0): ParseError {
  const m = match as any;
  const offset = baseOffset + (m.getRightmostFailurePosition?.() ?? 0);
  const expected = m.getExpectedText?.() ?? '';
  const interval = m.getInterval?.();
  let message: string = m.message ?? 'Parse error';
  if (interval !== undefined && (m.input !== source || baseOffset !== 0)) {
    message = `${new interval.constructor(source, offset, offset).getLineAndColumnMessage()}Expected ${expected}`;
  }
  return failureAt(source, offset, expected, message);
}

function failureAt(source: string, offset: number, expected: string, message: string): ParseError {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  const column = offset - lastNewline;
  let endOfLine = source.indexOf('\n', offset);
  if (endOfLine === -1) endOfLine = source.length;
  const actual = source.slice(offset, Math.min(endOfLine, offset + 40));
  return { line, column, offset, expected, actual, message };
}

export function nestingFailure(source: string, failure: SourceNestingFailure): ParseError {
  const error = failureAt(source, failure.offset, failure.expected, '');
  error.message = `Line ${error.line}, col ${error.column}: Brackets nest more than ${MAX_BRACKET_DEPTH} levels deep: the rules parser reads at most ${MAX_BRACKET_DEPTH}, a limit of this parser, not of production.`;
  return error;
}

export function stackFailure(source: string): ParseError {
  const error = failureAt(source, 0, 'an expression with fewer chained terms', '');
  error.message = 'Line 1, col 1: The rules source chains more terms than the rules parser reads.';
  return error;
}

export function leadingOffsetInfo(input: string): {
  leadingTrimmed: number;
  leadingLineOffset: number;
  initialColumnOffset: number;
} {
  const leadingTrimmed = input.length - input.trimStart().length;
  let leadingLineOffset = 0;
  let lastLeadingNewline = -1;
  for (let i = 0; i < leadingTrimmed; i++) {
    if (input.charCodeAt(i) === 10) {
      leadingLineOffset++;
      lastLeadingNewline = i;
    }
  }
  return {
    leadingTrimmed,
    leadingLineOffset,
    initialColumnOffset: leadingTrimmed - lastLeadingNewline - 1,
  };
}

function shiftSourceLoc(loc: { line: number; col: number; file?: string } | undefined, offset: number): void {
  if (loc !== undefined) loc.line += offset;
}

export function shiftFunctionLocs(fn: FunctionDef, offset: number): void {
  shiftSourceLoc(fn.loc, offset);
  for (const binding of fn.lets) {
    shiftSourceLoc(binding.loc, offset);
    shiftSourceLoc(binding.value.loc, offset);
  }
  shiftSourceLoc(fn.body.loc, offset);
  shiftSourceLoc(fn.returnLoc, offset);
}

export function shiftAstLines(ast: FirestoreRules, offset: number): void {
  shiftSourceLoc(ast.loc, offset);
  for (const imp of ast.imports) shiftSourceLoc(imp.loc, offset);
  for (const fn of ast.functions ?? []) shiftFunctionLocs(fn, offset);
  for (const service of ast.services ?? [ast.service]) shiftServiceLines(service, offset);
}

function shiftServiceLines(service: ServiceBlock, offset: number): void {
  shiftSourceLoc(service.loc, offset);
  for (const fn of service.functions ?? []) shiftFunctionLocs(fn, offset);
  const roots = service.matches ?? [service.match];
  const stack: MatchBlock[] = [...roots];
  while (stack.length > 0) {
    const block = stack.pop()!;
    shiftSourceLoc(block.loc, offset);
    for (const fn of block.functions) shiftFunctionLocs(fn, offset);
    for (const allow of block.allows) {
      shiftSourceLoc(allow.loc, offset);
      shiftSourceLoc(allow.condition.loc, offset);
    }
    for (const child of block.children) stack.push(child);
  }
}

export function attachFunctionSourceFile(fn: FunctionDef, file: string): void {
  if (fn.loc !== undefined) fn.loc.file = file;
  for (const binding of fn.lets) {
    if (binding.loc !== undefined) binding.loc.file = file;
    if (binding.value.loc !== undefined) binding.value.loc.file = file;
  }
  if (fn.returnLoc !== undefined) fn.returnLoc.file = file;
  if (fn.body.loc !== undefined) fn.body.loc.file = file;
}
