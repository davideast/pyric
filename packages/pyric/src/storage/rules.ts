/**
 * Storage rules — standalone subset.
 *
 * Why a separate evaluator (not the Firestore one):
 *
 * Firestore's grammar header is `service cloud.firestore` and its
 * bindings (`request.method` enum of get/list/create/update/delete,
 * `resource.data`, etc.) are deeply Firestore-shaped. Storage uses
 * `service firebase.storage` with different bindings
 * (`request.resource.size`, `request.resource.contentType`,
 * `resource.metadata`). The user's call (recorded in the v1 scope
 * plan): keep them independent so neither battles the other for
 * grammar generality.
 *
 * Subset implemented in Slice 8 (Section 5 of the v1 scope):
 *
 *   - `service firebase.storage { match … }` header
 *   - Nested `match` blocks with path segments:
 *       literal (`sessions`), parameter (`{sessionId}`), and
 *       multi-segment wildcard (`{allPaths=**}`)
 *   - `allow <verb>[, <verb>]* : if <expr>;` where verb is one of
 *     the coarse umbrellas (`read`, `write`) or the granular verbs
 *     (`get`, `list`, `create`, `update`, `delete`). `read` grants
 *     get + list; `write` grants create + update + delete; a granular
 *     grant covers only its own verb.
 *   - Expressions:
 *       literals: number, string, boolean, null
 *       identifiers: `request`, `resource`, plus path parameters
 *       member access (`a.b`), index access (`a['b']`)
 *       unary: `!`
 *       binary: `&& || == != < > <= >= + - * /`
 *       parens
 *
 * Out of scope (mirrors the survey + plan): `request.time`,
 * `matches()`/regex, function definitions, `customMetadata.<field>`
 * deep access (use bracket form against `resource.metadata` when
 * really needed). Hooks for adding more live at the obvious
 * extension seams in the parser + evaluator.
 */

// ═══════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════

/** Coarse permission umbrellas. `read` covers get + list; `write`
 *  covers create + update + delete. */
export type StorageMethod = 'read' | 'write';

/** Granular operation verbs. Production Storage maps each operation to
 *  exactly one of these:
 *    download / getMetadata      → get
 *    list                        → list
 *    upload to NONEXISTENT path  → create
 *    upload / updateMetadata over
 *      an EXISTING object        → update
 *    delete                      → delete
 */
export type StorageVerb = 'get' | 'list' | 'create' | 'update' | 'delete';

/** What a caller records as the request's operation. Callers pass the
 *  precise granular verb; the coarse forms remain accepted so the
 *  umbrella semantics are symmetric. */
export type StorageRequestMethod = StorageMethod | StorageVerb;

/** A verb token that may appear in an `allow` clause. */
export type StorageGrantVerb = StorageMethod | StorageVerb;

/**
 * Expand a coarse umbrella verb into its granular sub-verbs; a granular
 * verb expands to itself. This is the single definition of the
 * read→{get,list} / write→{create,update,delete} semantics, used by both
 * the request side and the grant side of matching.
 */
function expandVerb(verb: StorageGrantVerb | StorageRequestMethod): StorageVerb[] {
  switch (verb) {
    case 'read': return ['get', 'list'];
    case 'write': return ['create', 'update', 'delete'];
    default: return [verb];
  }
}

/** Identity passed in with the request. `null` is anonymous. */
export interface StorageAuth {
  uid: string;
  token?: Record<string, unknown>;
}

/** Inbound request bindings the rules see. */
export interface StorageRequest {
  auth: StorageAuth | null;
  method: StorageRequestMethod;
  /** Path of the object the request targets. */
  path: string;
  /** Per-Firebase: on writes, `request.resource` describes the
   *  about-to-write object. Omit for reads (the rules language
   *  treats `request.resource` as unset there). */
  resource?: { size: number; contentType?: string; metadata?: Record<string, string> };
}

/** Existing-object bindings (for `resource.*`). `null` when no
 *  object exists yet (creates). */
export interface StorageResource {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface EvaluationInput {
  request: StorageRequest;
  resource: StorageResource | null;
}

export interface EvaluationResult {
  allowed: boolean;
  /** Human-readable explanation of why — used by Slice 8's
   *  integration to populate `storage/unauthorized` error
   *  messages. */
  reasons: string[];
}

/** Opaque parsed-rules handle returned by `parseStorageRules`. */
export interface StorageRules {
  readonly _root: MatchBlock;
}

// ═══════════════════════════════════════════════════════════════
// AST
// ═══════════════════════════════════════════════════════════════

interface MatchBlock {
  segments: PathSegment[];
  children: MatchBlock[];
  allows: AllowRule[];
}

type PathSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'wildcard'; name: string };

interface AllowRule {
  verbs: StorageGrantVerb[];
  condition: Expr | null;
}

type BinaryOp = '&&' | '||' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/';

type Expr =
  | { kind: 'literal'; value: number | string | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; target: Expr; name: string }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'unary'; op: '!'; arg: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr };

// ═══════════════════════════════════════════════════════════════
// Lexer
// ═══════════════════════════════════════════════════════════════

type Token =
  | { kind: 'ident'; value: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'punct'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const KEYWORDS = new Set([
  'service', 'match', 'allow', 'if', 'true', 'false', 'null',
  'read', 'write', 'get', 'list', 'create', 'update', 'delete',
]);

/** Verb tokens accepted in an `allow` clause. */
const GRANT_VERBS = new Set<StorageGrantVerb>([
  'read', 'write', 'get', 'list', 'create', 'update', 'delete',
]);
const MULTI_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    // Line comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // String literals — single or double quoted, no escapes for the
    // v1 scope (rules examples are short and use plain ASCII strings).
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let value = '';
      while (i < source.length && source[i] !== quote) {
        value += source[i];
        i++;
      }
      if (i >= source.length) {
        throw new SyntaxError(`Unterminated string literal starting at offset ${start}.`);
      }
      i++; // skip closing quote
      tokens.push({ kind: 'string', value, pos: start });
      continue;
    }
    // Numbers — integer only; the v1 scope's only number usage is size
    // literals like `10 * 1024 * 1024`. Floats can extend later.
    if (ch >= '0' && ch <= '9') {
      const start = i;
      let n = '';
      while (i < source.length && source[i] >= '0' && source[i] <= '9') {
        n += source[i];
        i++;
      }
      tokens.push({ kind: 'number', value: Number(n), pos: start });
      continue;
    }
    // Identifiers / keywords
    if (isIdentStart(ch)) {
      const start = i;
      let name = '';
      while (i < source.length && isIdentPart(source[i])) {
        name += source[i];
        i++;
      }
      tokens.push({ kind: 'ident', value: name, pos: start });
      continue;
    }
    // Multi-char operators
    const two = source.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ kind: 'punct', value: two, pos: i });
      i += 2;
      continue;
    }
    // Single-char punctuation
    if ('{}()[].,;:=*+-/<>!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, pos: i });
      i++;
      continue;
    }
    throw new SyntaxError(`Unexpected character "${ch}" at offset ${i}.`);
  }
  tokens.push({ kind: 'eof', pos: source.length });
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

// ═══════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parseService(): MatchBlock {
    this.expectIdent('service');
    this.expectIdent('firebase');
    this.expectPunct('.');
    this.expectIdent('storage');
    this.expectPunct('{');
    const root: MatchBlock = { segments: [], children: [], allows: [] };
    while (!this.atPunct('}')) {
      this.parseMatchInto(root);
    }
    this.expectPunct('}');
    return root;
  }

  /** Parse a `match /path/segments { ... }` block as a child of
   *  `parent`. Empty path (just `match { ... }`) is illegal. */
  private parseMatchInto(parent: MatchBlock): void {
    this.expectIdent('match');
    const segments = this.parsePath();
    this.expectPunct('{');
    const block: MatchBlock = { segments, children: [], allows: [] };
    while (!this.atPunct('}')) {
      if (this.atIdent('match')) {
        this.parseMatchInto(block);
      } else if (this.atIdent('allow')) {
        block.allows.push(this.parseAllow());
      } else {
        const t = this.peek();
        throw new SyntaxError(
          `Expected 'match' or 'allow' inside match block at offset ${t.pos}, got "${describeToken(t)}".`,
        );
      }
    }
    this.expectPunct('}');
    parent.children.push(block);
  }

  /** Parse a path like `/b/{bucket}/o/{allPaths=**}` into segments. */
  private parsePath(): PathSegment[] {
    const segments: PathSegment[] = [];
    while (this.atPunct('/')) {
      this.expectPunct('/');
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        this.expectPunct('{');
        const name = this.expectIdentValue();
        // `{name=**}` wildcard form
        if (this.atPunct('=')) {
          this.expectPunct('=');
          this.expectPunct('*');
          this.expectPunct('*');
          this.expectPunct('}');
          segments.push({ kind: 'wildcard', name });
        } else {
          this.expectPunct('}');
          segments.push({ kind: 'param', name });
        }
      } else if (t.kind === 'ident') {
        // Literal segment — `match /sessions/{id}` etc.
        segments.push({ kind: 'literal', value: t.value });
        this.pos++;
      } else {
        throw new SyntaxError(
          `Expected path segment after '/' at offset ${t.pos}.`,
        );
      }
    }
    if (segments.length === 0) {
      throw new SyntaxError(
        `Empty match path at offset ${this.peek().pos}.`,
      );
    }
    return segments;
  }

  /** Parse `allow <verb>[, <verb>]*: if <expr>;` */
  private parseAllow(): AllowRule {
    this.expectIdent('allow');
    const verbs: StorageGrantVerb[] = [];
    verbs.push(this.parseVerb());
    while (this.atPunct(',')) {
      this.expectPunct(',');
      verbs.push(this.parseVerb());
    }
    this.expectPunct(':');
    let condition: Expr | null = null;
    if (this.atIdent('if')) {
      this.expectIdent('if');
      condition = this.parseExpression();
    }
    this.expectPunct(';');
    return { verbs, condition };
  }

  private parseVerb(): StorageGrantVerb {
    const t = this.expect('ident');
    if (GRANT_VERBS.has(t.value as StorageGrantVerb)) {
      return t.value as StorageGrantVerb;
    }
    throw new SyntaxError(
      `Unsupported verb "${t.value}" at offset ${t.pos}. Storage rules support read, write, get, list, create, update, and delete.`,
    );
  }

  // Expression precedence (loose → tight):
  //   OR (||)  →  AND (&&)  →  EQ (==/!=)  →  REL (</>/<=/>=)  →
  //   ADD (+/-)  →  MUL (*//)  →  UNARY (!) →  PRIMARY
  private parseExpression(): Expr { return this.parseOr(); }
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.atPunct('||')) {
      this.expectPunct('||');
      left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseEq();
    while (this.atPunct('&&')) {
      this.expectPunct('&&');
      left = { kind: 'binary', op: '&&', left, right: this.parseEq() };
    }
    return left;
  }
  private parseEq(): Expr {
    let left = this.parseRel();
    while (this.atPunct('==') || this.atPunct('!=')) {
      const op = this.expect('punct').value as '==' | '!=';
      left = { kind: 'binary', op, left, right: this.parseRel() };
    }
    return left;
  }
  private parseRel(): Expr {
    let left = this.parseAdd();
    while (this.atPunct('<') || this.atPunct('>') || this.atPunct('<=') || this.atPunct('>=')) {
      const op = this.expect('punct').value as '<' | '>' | '<=' | '>=';
      left = { kind: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.atPunct('+') || this.atPunct('-')) {
      const op = this.expect('punct').value as '+' | '-';
      left = { kind: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.atPunct('*') || this.atPunct('/')) {
      const op = this.expect('punct').value as '*' | '/';
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): Expr {
    if (this.atPunct('!')) {
      this.expectPunct('!');
      return { kind: 'unary', op: '!', arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }
  /** `.name` and `[expr]` chain after a primary. */
  private parsePostfix(): Expr {
    let target = this.parsePrimary();
    for (;;) {
      if (this.atPunct('.')) {
        this.expectPunct('.');
        const name = this.expectIdentValue();
        target = { kind: 'member', target, name };
      } else if (this.atPunct('[')) {
        this.expectPunct('[');
        const index = this.parseExpression();
        this.expectPunct(']');
        target = { kind: 'index', target, index };
      } else {
        return target;
      }
    }
  }
  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '(') {
      this.expectPunct('(');
      const e = this.parseExpression();
      this.expectPunct(')');
      return e;
    }
    if (t.kind === 'number') {
      this.pos++;
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'string') {
      this.pos++;
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === 'ident') {
      this.pos++;
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'ident', name: t.value };
    }
    throw new SyntaxError(`Unexpected token "${describeToken(t)}" at offset ${t.pos}.`);
  }

  // ─── Token helpers ─────────────────────────────────────────
  private peek(): Token { return this.tokens[this.pos]; }
  private atPunct(value: string): boolean {
    const t = this.tokens[this.pos];
    return t.kind === 'punct' && t.value === value;
  }
  private atIdent(value: string): boolean {
    const t = this.tokens[this.pos];
    return t.kind === 'ident' && t.value === value;
  }
  private expect<K extends Token['kind']>(kind: K): Extract<Token, { kind: K }> {
    const t = this.tokens[this.pos];
    if (t.kind !== kind) {
      throw new SyntaxError(
        `Expected ${kind} at offset ${t.pos}, got "${describeToken(t)}".`,
      );
    }
    this.pos++;
    return t as Extract<Token, { kind: K }>;
  }
  private expectIdent(value: string): void {
    const t = this.expect('ident');
    if (t.value !== value) {
      throw new SyntaxError(
        `Expected keyword "${value}" at offset ${t.pos}, got "${t.value}".`,
      );
    }
  }
  private expectIdentValue(): string {
    const t = this.expect('ident');
    return t.value;
  }
  private expectPunct(value: string): void {
    const t = this.expect('punct');
    if (t.value !== value) {
      throw new SyntaxError(
        `Expected "${value}" at offset ${t.pos}, got "${t.value}".`,
      );
    }
  }
}

function describeToken(t: Token): string {
  if (t.kind === 'eof') return '<eof>';
  if (t.kind === 'string') return JSON.stringify(t.value);
  return String((t as { value: unknown }).value);
}

// ═══════════════════════════════════════════════════════════════
// Public entry points
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a Storage rules source into an opaque handle. Throws
 * `SyntaxError` on malformed input. Used by Slice 8's
 * `getStorage(ctx, { rules })` to validate upfront.
 */
export function parseStorageRules(source: string): StorageRules {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  const root = parser.parseService();
  return { _root: root };
}

/**
 * Adapt a persisted metadata record into the `resource.*` binding the
 * rules language sees.
 *
 * The persistence layer stores client custom metadata under
 * `customMetadata` (`StoredMetadata.customMetadata`), but the rules
 * language exposes it as `resource.metadata.<key>`. Without this
 * mapping every `resource.metadata.X` reference reads `undefined` and
 * metadata-based authorization fails open (#764). This is the single
 * seam that keeps the two shapes reconciled — every gated read/delete
 * call site feeds `resource` through here.
 */
export function resourceFromStored(
  stored:
    | { size: number; contentType?: string; customMetadata?: Record<string, string> }
    | null
    | undefined,
): StorageResource | null {
  if (!stored) return null;
  return {
    size: stored.size,
    contentType: stored.contentType,
    metadata: stored.customMetadata,
  };
}

/**
 * Build the `request.resource` binding for a write. The custom
 * metadata the client is about to set becomes `request.resource.metadata`
 * so `allow write: if request.resource.metadata.owner == request.auth.uid`
 * evaluates against the real incoming value rather than `undefined`.
 */
export function requestResourceFor(args: {
  size: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
}): NonNullable<StorageRequest['resource']> {
  return {
    size: args.size,
    contentType: args.contentType,
    metadata: args.customMetadata,
  };
}

/**
 * Evaluate the rules against a request + resource binding. Returns
 * `{ allowed, reasons }`. `allowed` is true iff any `allow` clause
 * at any matching match block evaluates to a truthy condition.
 *
 * Path-matching strategy: the request's path is segmented and
 * walked against the AST's match tree. Wildcards (`{p=**}`) match
 * zero or more remaining segments; named params bind one segment.
 *
 * Multi-clause failure mode: when no clause matches, `reasons`
 * contains a short trace ("no match found for path X" or "rule at
 * match /sessions/{id} denied: condition false"). Helpful for the
 * playground's error surface.
 */
export function evaluateStorageRules(
  rules: StorageRules,
  input: EvaluationInput,
): EvaluationResult {
  const pathSegments = splitPath(input.request.path);
  const reasons: string[] = [];

  // The operation's verb, reduced to its granular set. A coarse
  // request method expands to its sub-verbs so umbrella semantics are
  // symmetric; a precise granular verb expands to itself.
  const requestVerbs = new Set(expandVerb(input.request.method));

  /**
   * Walk a match block. `remaining` is the still-unmatched part of
   * the request path; `params` are the bindings accumulated so far.
   * Recurses into matching children. Whenever a block fully
   * consumes the path, its `allow` rules run.
   */
  function visit(
    block: MatchBlock,
    remaining: string[],
    params: Record<string, string | string[]>,
  ): boolean {
    // Match this block's segments against the start of `remaining`.
    const match = matchSegments(block.segments, remaining, params);
    if (!match) return false;
    const newParams = match.params;
    const left = match.left;

    // If this block fully consumes the path, evaluate its allow
    // rules. (Or if a wildcard absorbed the remainder.)
    if (left.length === 0) {
      for (const rule of block.allows) {
        // A grant applies when the operation's verb falls within the
        // grant's verbs after coarse→granular expansion. `allow read`
        // covers get + list; `allow get` covers only get.
        const grantVerbs = new Set(rule.verbs.flatMap(expandVerb));
        const applies = [...requestVerbs].some((v) => grantVerbs.has(v));
        if (!applies) continue;
        const result = rule.condition
          ? truthy(evalExpr(rule.condition, input, newParams))
          : true;
        if (result) return true;
        reasons.push(
          `match ${formatPath(block.segments)} ${input.request.method}: condition false`,
        );
      }
    }
    // Recurse into children with the leftover path.
    for (const child of block.children) {
      if (visit(child, left, newParams)) return true;
    }
    return false;
  }

  const allowed = visit(rules._root, pathSegments, {});
  if (!allowed && reasons.length === 0) {
    reasons.push(`no rule matches ${input.request.method} /${pathSegments.join('/')}`);
  }
  return { allowed, reasons };
}

// ═══════════════════════════════════════════════════════════════
// Evaluation helpers
// ═══════════════════════════════════════════════════════════════

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function formatPath(segments: PathSegment[]): string {
  return (
    '/' +
    segments
      .map((s) => {
        if (s.kind === 'literal') return s.value;
        if (s.kind === 'param') return `{${s.name}}`;
        return `{${s.name}=**}`;
      })
      .join('/')
  );
}

/**
 * Match `segments` against the head of `remaining`. Returns the
 * leftover path (if any) and the accumulated params, or `null` on
 * failure. A wildcard segment must be the LAST entry in the block's
 * segments — it consumes everything that remains.
 */
function matchSegments(
  segments: PathSegment[],
  remaining: string[],
  params: Record<string, string | string[]>,
): { left: string[]; params: Record<string, string | string[]> } | null {
  let i = 0;
  const next = { ...params };
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.kind === 'wildcard') {
      next[seg.name] = remaining.slice(i);
      return { left: [], params: next };
    }
    if (i >= remaining.length) return null;
    if (seg.kind === 'literal') {
      if (remaining[i] !== seg.value) return null;
      i++;
    } else {
      // param
      next[seg.name] = remaining[i];
      i++;
    }
  }
  return { left: remaining.slice(i), params: next };
}

function truthy(v: unknown): boolean {
  return v !== false && v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
}

/**
 * Walk an `Expr` against the bindings + path params. The error
 * model is intentionally Lax: an undefined member access returns
 * `undefined` rather than throwing (mirrors what Firestore rules
 * do — a missing `resource.size` against a freshly-created object
 * is normal). `undefined` is falsy under `truthy`.
 */
function evalExpr(
  expr: Expr,
  input: EvaluationInput,
  params: Record<string, string | string[]>,
): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ident': {
      if (expr.name === 'request') return buildRequestObject(input);
      if (expr.name === 'resource') return input.resource;
      if (expr.name in params) return params[expr.name];
      return undefined;
    }
    case 'member': {
      const t = evalExpr(expr.target, input, params);
      if (t === null || t === undefined) return undefined;
      const obj = t as Record<string, unknown>;
      return obj[expr.name];
    }
    case 'index': {
      const t = evalExpr(expr.target, input, params);
      if (t === null || t === undefined) return undefined;
      const idx = evalExpr(expr.index, input, params);
      const obj = t as Record<string | number, unknown>;
      return obj[idx as string];
    }
    case 'unary':
      return !truthy(evalExpr(expr.arg, input, params));
    case 'binary': {
      // Short-circuit && / || so half-undefined chains don't trip
      // (e.g. `request.auth != null && request.auth.uid == 'a'`).
      if (expr.op === '&&') {
        const l = evalExpr(expr.left, input, params);
        return truthy(l) ? evalExpr(expr.right, input, params) : l;
      }
      if (expr.op === '||') {
        const l = evalExpr(expr.left, input, params);
        return truthy(l) ? l : evalExpr(expr.right, input, params);
      }
      const l = evalExpr(expr.left, input, params);
      const r = evalExpr(expr.right, input, params);
      switch (expr.op) {
        // Firebase rules treat `null` and `undefined` as
        // equivalent (helpful for `request.resource == null` on
        // deletes, which don't carry a resource payload). Mirror
        // that semantic; everything else is strict equality.
        case '==': return l === r || (l == null && r == null);
        case '!=': return !(l === r || (l == null && r == null));
        case '<':  return cmp(l, r) < 0;
        case '>':  return cmp(l, r) > 0;
        case '<=': return cmp(l, r) <= 0;
        case '>=': return cmp(l, r) >= 0;
        case '+':  return numOp(l, r, (a, b) => a + b);
        case '-':  return numOp(l, r, (a, b) => a - b);
        case '*':  return numOp(l, r, (a, b) => a * b);
        case '/':  return numOp(l, r, (a, b) => a / b);
      }
    }
  }
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return Number.NaN; // mismatched types → NaN → all comparisons return false
}

function numOp(a: unknown, b: unknown, fn: (x: number, y: number) => number): unknown {
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  return fn(a, b);
}

function buildRequestObject(input: EvaluationInput): Record<string, unknown> {
  return {
    auth: input.request.auth,
    resource: input.request.resource,
    method: input.request.method,
    path: input.request.path,
  };
}
