/**
 * Matching deeply nested rules source in segments the host stack can hold.
 *
 * The grammar is matched by a recursive descent that spends a chain of stack
 * frames on every precedence level of every nested bracket. Node's default
 * stack holds far fewer of those than bun's: measured through the public
 * `firestoreRules()` from `dist`, Node 22.15 exhausts it at 80 parenthesized
 * groups, 66 nested list literals and 63 nested map literals, while production
 * compiles 97 groups and lists (`paren-nesting`, `list-nesting` in
 * `test/rules/linter/fixtures/compile-limits/captures.json`). So source that
 * nests more than {@link SEGMENT_DEPTH} brackets is matched in pieces: every
 * bracket at that depth is replaced by a placeholder identifier, the outer
 * text is matched, each replaced bracket is matched on its own (in turn in
 * pieces when it nests that deep again), and the ASTs are spliced back
 * together. No single match descends more than {@link SEGMENT_DEPTH} brackets
 * below where it starts.
 *
 * Every replacement keeps the source's length and line breaks, so offsets,
 * lines and columns of the outer text are those of the source. A piece that
 * fails to match is a parse failure at its own position. A placeholder the
 * outer AST does not hold exactly once, in a slot where the bracket it stands
 * for can sit, is a failure too: the segmented match never accepts source
 * that the whole match would reject.
 */
import type { Expression } from './FirestoreAST.js';
import { scanBrackets, type BracketSpan } from './bracket-scan.js';
import { completionPosition, setCompletionPosition } from './expression-positions.js';
import { addParenthesizedGroup, parenthesizedGroups } from './paren-groups.js';

/**
 * Most brackets one match descends before the brackets at that depth are
 * matched on their own. Node 22.15 holds 63 to 80 from a shallow caller
 * stack, depending on the bracket kind; this leaves room for a deep one.
 */
export const SEGMENT_DEPTH = 24;

/**
 * Starts every placeholder. It is a letter to the grammar, so a placeholder
 * reads as an identifier, and source that holds it is never segmented.
 */
const MARK = '\u01C2\u01C2';
/** The function a replaced argument list or index is matched behind. */
const WRAPPER = `${MARK}w\u01C2`;

/**
 * How a replaced bracket returns to the AST:
 * - `expr`: the placeholder stands for a whole expression (a group, a list
 *   or map literal, or the content of a path interpolation);
 * - `args`: it is the only argument of a function or method call and stands
 *   for the argument list;
 * - `index`: it is the index of an index access and stands for the index or
 *   slice.
 */
export type SegmentKind = 'expr' | 'args' | 'index';

/** One replaced bracket. */
export interface Segment {
  /** The placeholder identifier. */
  name: string;
  kind: SegmentKind;
  /** Offset in the outer text where the replaced characters start. */
  start: number;
  /** The replaced characters, as the source has them. */
  original: string;
  /** What replaces them: the placeholder, padded to the same length with the same line breaks. */
  replacement: string;
  /** The text to match from `Expr` for this piece. */
  text: string;
  /** Offset in `text` that corresponds to `start` in the outer text. */
  prefix: number;
}

/** The outer text with its brackets at {@link SEGMENT_DEPTH} replaced, and those brackets. */
export interface SegmentedSource {
  text: string;
  segments: Segment[];
}

const isIdentChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 0x01c2;

/** `chars` padded to the length of `original`, keeping each of its line breaks; undefined when `chars` would cross one. */
function pad(original: string, chars: string): string | undefined {
  if (original.length <= chars.length) return undefined;
  if (/[\n\r]/.test(original.slice(0, chars.length))) return undefined;
  return chars + original.slice(chars.length).replace(/[^\n\r]/g, ' ');
}

/** The replacement for one bracket, or undefined when it cannot be replaced and its own brackets are tried instead. */
function segmentFor(text: string, span: BracketSpan, name: string): Segment | undefined {
  if (span.close === -1) return undefined;
  let before = 32;
  if (span.open > 0) before = text.charCodeAt(span.open - 1);
  switch (span.kind) {
    case 'group':
    case 'list':
    case 'map': {
      // Directly after `/` a group may be a path segment, and the character
      // after a `/` operator decides how production reads it.
      if (before === 47 /* / */ || span.items === 0) return undefined;
      const original = text.slice(span.open, span.close + 1);
      const replacement = pad(original, isIdentChar(before) ? ` ${name}` : name);
      if (replacement === undefined) return undefined;
      return { name, kind: 'expr', start: span.open, original, replacement, text: original, prefix: 0 };
    }
    case 'interpolation':
    case 'call':
    case 'method':
    case 'index': {
      if (span.items === 0 || span.declaration) return undefined;
      const original = text.slice(span.open + 1, span.close);
      const replacement = pad(` ${original}`, ` ${name}`)?.slice(1);
      if (replacement === undefined) return undefined;
      if (span.kind === 'interpolation') {
        return { name, kind: 'expr', start: span.open + 1, original, replacement, text: original, prefix: 0 };
      }
      const kind: SegmentKind = span.kind === 'index' ? 'index' : 'args';
      const piece = `${WRAPPER}${text.slice(span.open, span.close + 1)}`;
      return { name, kind, start: span.open + 1, original, replacement, text: piece, prefix: WRAPPER.length + 1 };
    }
    default:
      return undefined;
  }
}

/**
 * `text` with every bracket that sits {@link SEGMENT_DEPTH} or more brackets
 * deep, outside another replaced one, replaced by a placeholder. Undefined
 * when nothing nests that deep, or when the text already holds the
 * placeholder mark past the wrapper a piece may start with.
 *
 * A piece's outer bracket is at depth 1 and must not be replaced by a
 * placeholder again (which would leave the same piece to match), so `depth`
 * is at least 2.
 */
export function segmentSource(text: string, depth: number = SEGMENT_DEPTH): SegmentedSource | undefined {
  if (text.indexOf(MARK, text.startsWith(WRAPPER) ? WRAPPER.length : 0) !== -1) return undefined;
  const cut = Math.max(depth, 2);
  const spans = scanBrackets(text, { comments: true, regexLiterals: false, multilineStrings: false });
  const segments: Segment[] = [];
  const parts: string[] = [];
  let copiedTo = 0;
  for (const span of spans) {
    if (span.depth < cut || span.open < copiedTo) continue;
    const segment = segmentFor(text, span, `${MARK}${segments.length}\u01C2`);
    if (segment === undefined) continue;
    parts.push(text.slice(copiedTo, segment.start), segment.replacement);
    copiedTo = segment.start + segment.original.length;
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  parts.push(text.slice(copiedTo));
  return { text: parts.join(''), segments };
}

/** A matched piece, ready to splice. */
export interface SplicePart {
  segment: Segment;
  ast: Expression;
}

function placeholderName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const node = value as { type?: unknown; name?: unknown };
  if (node.type !== 'identifier' || typeof node.name !== 'string' || !node.name.startsWith(MARK)) return undefined;
  return node.name === WRAPPER ? undefined : node.name;
}

function isWrapper(value: Expression): boolean {
  return value.type === 'identifier' && value.name === WRAPPER;
}

/** Whether `expr` is a placeholder for a replaced bracket. */
export function isSegmentPlaceholder(expr: Expression): boolean {
  return placeholderName(expr) !== undefined;
}

type Take = (name: string, kind: SegmentKind) => SplicePart | undefined;

/**
 * `root` (a rules file or an expression) with every placeholder replaced by
 * the AST of the bracket it stands for. Undefined when a placeholder is
 * missing, repeated, or in a slot its bracket cannot fill: the outer text
 * then matched only because of the replacement.
 */
export function spliceSegments(root: object, parts: ReadonlyMap<string, SplicePart>): object | undefined {
  const used = new Set<string>();
  const spliced = new WeakSet<object>();
  const kindOf = (name: string) => parts.get(name)?.segment.kind;
  const take: Take = (name, kind) => {
    const part = parts.get(name);
    if (part === undefined || part.segment.kind !== kind || used.has(name)) return undefined;
    used.add(name);
    spliced.add(part.ast);
    return part;
  };
  // An expression piece may be a placeholder in parentheses and nothing more.
  const rootName = placeholderName(root);
  if (rootName !== undefined) {
    const part = take(rootName, 'expr');
    if (part === undefined || used.size !== parts.size) return undefined;
    return spliceExpression(root as Expression, part.ast);
  }
  const stack: object[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()! as Record<string, unknown>;
    if (spliced.has(node) || ArrayBuffer.isView(node)) continue;
    if (!spliceNode(node, kindOf, take)) return undefined;
    if (node.type === 'pathLiteral' && !restorePathRaw(node, parts)) return undefined;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value !== 'object' || value === null) continue;
      const name = placeholderName(value);
      if (name === undefined) {
        stack.push(value);
        continue;
      }
      // A map entry's key is an identifier node, but no bracket can stand there.
      if (key === 'key' && 'value' in node && !('type' in node)) return undefined;
      const part = take(name, 'expr');
      if (part === undefined) return undefined;
      node[key] = spliceExpression(value as Expression, part.ast);
    }
  }
  return used.size === parts.size ? root : undefined;
}

/** The piece's AST in place of its placeholder, with the parenthesized groups around the placeholder. */
function spliceExpression(placeholder: Expression, ast: Expression): Expression {
  const groups = parenthesizedGroups(placeholder);
  for (let i = 0; i < groups; i++) addParenthesizedGroup(ast);
  // A parenthesized conjunction completes at its outermost parenthesis,
  // which the parser recorded on the placeholder.
  const completion = completionPosition(placeholder);
  if (groups > 0 && completion !== undefined && ast.type === 'binaryOp' && ast.op === '&&') {
    setCompletionPosition(ast, completion);
  }
  return ast;
}

/** Splice an argument list or index into the call or access that holds its placeholder. */
function spliceNode(node: Record<string, unknown>, kindOf: (name: string) => SegmentKind | undefined, take: Take): boolean {
  if (node.type === 'functionCall' || node.type === 'methodCall') {
    const args = node.args as Expression[];
    if (args.length !== 1) return true;
    const name = placeholderName(args[0]);
    if (name === undefined || kindOf(name) !== 'args') return true;
    const sub = take(name, 'args')?.ast;
    if (sub === undefined || sub.type !== 'functionCall' || sub.name !== WRAPPER) return false;
    node.args = sub.args;
    return true;
  }
  if (node.type === 'bracketAccess') {
    const name = placeholderName(node.index);
    if (name === undefined || kindOf(name) !== 'index') return true;
    const sub = take(name, 'index')?.ast;
    if (sub === undefined) return false;
    if (sub.type === 'bracketAccess' && isWrapper(sub.object)) {
      node.index = sub.index;
      return true;
    }
    if (sub.type === 'sliceAccess' && isWrapper(sub.object)) {
      delete node.index;
      node.type = 'sliceAccess';
      node.start = sub.start;
      node.end = sub.end;
      return true;
    }
    return false;
  }
  return true;
}

/** A path literal's `raw` with each replaced bracket's characters restored; false when a placeholder remains. */
function restorePathRaw(node: Record<string, unknown>, parts: ReadonlyMap<string, SplicePart>): boolean {
  let raw = node.raw as string;
  if (!raw.includes(MARK)) return true;
  for (const { segment } of parts.values()) {
    if (raw.includes(segment.name)) raw = raw.split(segment.replacement).join(segment.original);
  }
  node.raw = raw;
  return !raw.includes(MARK);
}

/** A matched piece's AST, or why it failed. */
export type PieceResult<E> = { ok: true; ast: object } | { ok: false; error: E };

/**
 * Match `text` from `startRule` and build its AST. Offset `prefix` of `text`
 * is offset `offset` of the source; characters before it are a wrapper that
 * is not in the source.
 */
export type MatchPiece<E> = (text: string, startRule: string | undefined, offset: number, prefix: number) => PieceResult<E>;

/** `text` with each replaced expression bracket shortened to `(1)`, which is not an identifier. */
function withShortGroups(text: string, segments: readonly Segment[]): string {
  const parts: string[] = [];
  let copiedTo = 0;
  for (const segment of segments) {
    let short: string | undefined;
    if (segment.kind === 'expr') short = pad(segment.original, '(1)');
    parts.push(text.slice(copiedTo, segment.start), short ?? segment.replacement);
    copiedTo = segment.start + segment.original.length;
  }
  parts.push(text.slice(copiedTo));
  return parts.join('');
}

/**
 * Match `text` (offset `prefix` of it at offset `offset` of the source) in
 * pieces that each descend at most `depth` brackets, and splice their ASTs.
 * Text that nests less deeply is matched whole.
 */
export function matchSegmented<E>(
  text: string,
  startRule: string | undefined,
  matchPiece: MatchPiece<E>,
  offset: number = 0,
  prefix: number = 0,
  depth: number = SEGMENT_DEPTH,
): PieceResult<E> {
  const segmented = segmentSource(text, depth);
  if (segmented === undefined) return matchPiece(text, startRule, offset, prefix);
  const outer = matchPiece(segmented.text, startRule, offset, prefix);
  if (!outer.ok) return outer;
  const parts = new Map<string, SplicePart>();
  for (const segment of segmented.segments) {
    const at = offset + segment.start - prefix;
    const piece = matchSegmented(segment.text, 'Expr', matchPiece, at, segment.prefix, depth);
    if (!piece.ok) return piece;
    parts.set(segment.name, { segment, ast: piece.ast as Expression });
  }
  const ast = spliceSegments(outer.ast, parts);
  if (ast === undefined) return matchPiece(withShortGroups(text, segmented.segments), startRule, offset, prefix);
  return { ok: true, ast };
}
