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
 *       user-defined function calls (`isOwner(uid)`)
 *       `request.time` compared against the timestamp constructors
 *         `timestamp.date(y, m, d)` (UTC midnight) and
 *         `timestamp.value(epochMillis)`. The caller injects the time
 *         (3rd arg to `evaluateStorageRules`), defaulting to now.
 *       `string.matches(re)` — whole-string RE2-style regex match
 *         (see `evalMatches` for the RE2-vs-JS divergence handling)
 *       custom-metadata access in both dotted (`resource.metadata.owner`)
 *         and bracket (`resource.metadata['owner']`) form — the metadata
 *         map is a plain string→string object, so both resolve identically
 *         and a missing key is `undefined` (falsy → deny).
 *   - `function name(params) { let …; return expr; }` declarations at
 *     service scope or inside a `match` block. Lexically scoped (visible
 *     within the declaring block and nested blocks; inner shadows
 *     outer), may call other functions, support `let` bindings, and are
 *     depth-capped. Any function-eval failure denies with a reason.
 *
 * Still out of scope (mirrors the survey + plan): cross-document lookups
 * (`firestore.get`/`exists`) and `resource.timeCreated`/`updated`
 * (the evaluator's resource model carries size/contentType/metadata only,
 * not server timestamps — those fields read `undefined`). Unknown builtins
 * deny with a reason rather than false-allow. Hooks for adding more live at
 * the obvious extension seams in the parser + evaluator.
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

/**
 * Injected capability that lets a Storage rule read Firestore documents
 * (`firestore.get(path)` / `firestore.exists(path)`), WITHOUT the pure
 * evaluator importing the Firestore sandbox. The enforcement layer builds
 * one from the sandbox's admin Firestore accessor (a synchronous in-memory
 * read) and passes it into {@link evaluateStorageRules}; pure/test callers
 * that omit it get the deny-with-reason "unsupported" behavior instead.
 *
 * Paths are the document path RELATIVE to the database — the
 * `collection/doc` form `sandbox.admin.getDocument` expects — after the
 * evaluator has stripped the `/databases/<db>/documents/` prefix from the
 * rule's path literal.
 */
export interface FirestoreLookup {
  /** The document's fields, or `null` when the document does not exist. */
  get(path: string): Record<string, unknown> | null;
  /** Whether a document exists at `path`. */
  exists(path: string): boolean;
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
  /** User-defined functions declared directly in this block. */
  functions: FunctionDef[];
  /** Functions visible to conditions/bodies declared in this block:
   *  ancestor functions plus this block's, inner shadowing outer.
   *  Resolved once by `resolveFunctions` after parsing. */
  visibleFuncs?: FunctionMap;
}

/** A user-defined `function name(params) { let …; return expr; }`. */
interface FunctionDef {
  name: string;
  params: string[];
  /** `let` bindings evaluated in order before the return, each visible
   *  to those after it and to the return expression. */
  lets: { name: string; value: Expr }[];
  body: Expr;
  /** Lexical scope: the functions visible from this function's body
   *  (its declaring block's `visibleFuncs`). Resolved after parsing so
   *  a call's body uses declaration-site scope, not the caller's. */
  declScope?: FunctionMap;
}

type FunctionMap = Map<string, FunctionDef>;

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
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  /** A method / namespace call: `<target>.<method>(args)`. Covers
   *  `string.matches(re)` (target is any string expr) and the timestamp
   *  namespace constructors `timestamp.date(y,m,d)` / `timestamp.value(ms)`
   *  (target is the bare `timestamp` identifier). */
  | { kind: 'methodcall'; target: Expr; method: string; args: Expr[] }
  /** A Firestore path literal — the argument to `firestore.get()` /
   *  `firestore.exists()`, e.g.
   *  `/databases/(default)/documents/users/$(request.auth.uid)`. Segments
   *  are either fixed text or `$(expr)` interpolations resolved at eval.
   *  Only meaningful as a Firestore-lookup argument; evaluating one in any
   *  other position denies (see `evalExpr`). */
  | { kind: 'path'; segments: PathArgSegment[] };

/** One segment of a {@link Expr} `path` literal. */
type PathArgSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'interp'; expr: Expr };

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
  'function', 'let', 'return',
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
    // Single-char punctuation. `$` is here for `$(expr)` interpolation
    // segments inside a Firestore path literal (`firestore.get(/…/$(x))`).
    if ('{}()[].,;:=*+-/<>!|&$'.includes(ch)) {
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
    const root: MatchBlock = { segments: [], children: [], allows: [], functions: [] };
    while (!this.atPunct('}')) {
      if (this.atIdent('function')) {
        root.functions.push(this.parseFunction());
      } else {
        this.parseMatchInto(root);
      }
    }
    this.expectPunct('}');
    return root;
  }

  /** Parse `function name(p1, p2) { let x = e; … return e; }`. */
  private parseFunction(): FunctionDef {
    this.expectIdent('function');
    const name = this.expectIdentValue();
    this.expectPunct('(');
    const params: string[] = [];
    if (!this.atPunct(')')) {
      params.push(this.expectIdentValue());
      while (this.atPunct(',')) {
        this.expectPunct(',');
        params.push(this.expectIdentValue());
      }
    }
    this.expectPunct(')');
    this.expectPunct('{');
    const lets: { name: string; value: Expr }[] = [];
    while (this.atIdent('let')) {
      this.expectIdent('let');
      const bindName = this.expectIdentValue();
      this.expectPunct('=');
      const value = this.parseExpression();
      this.expectPunct(';');
      lets.push({ name: bindName, value });
    }
    this.expectIdent('return');
    const body = this.parseExpression();
    this.expectPunct(';');
    this.expectPunct('}');
    return { name, params, lets, body };
  }

  /** Parse a `match /path/segments { ... }` block as a child of
   *  `parent`. Empty path (just `match { ... }`) is illegal. */
  private parseMatchInto(parent: MatchBlock): void {
    this.expectIdent('match');
    const segments = this.parsePath();
    this.expectPunct('{');
    const block: MatchBlock = { segments, children: [], allows: [], functions: [] };
    while (!this.atPunct('}')) {
      if (this.atIdent('match')) {
        this.parseMatchInto(block);
      } else if (this.atIdent('allow')) {
        block.allows.push(this.parseAllow());
      } else if (this.atIdent('function')) {
        block.functions.push(this.parseFunction());
      } else {
        const t = this.peek();
        throw new SyntaxError(
          `Expected 'match', 'allow', or 'function' inside match block at offset ${t.pos}, got "${describeToken(t)}".`,
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
      } else if (this.atPunct('(')) {
        // Call. Two shapes are accepted:
        //   - bare ident `f(...)`   → user-defined function call
        //   - member `x.m(...)`     → method / namespace call
        //     (`string.matches(re)`, `timestamp.date(...)`, …)
        // Anything else (e.g. `x['k'](...)`) is not callable.
        this.expectPunct('(');
        const args: Expr[] = [];
        if (!this.atPunct(')')) {
          args.push(this.parseExpression());
          while (this.atPunct(',')) {
            this.expectPunct(',');
            args.push(this.parseExpression());
          }
        }
        this.expectPunct(')');
        if (target.kind === 'ident') {
          target = { kind: 'call', name: target.name, args };
        } else if (target.kind === 'member') {
          target = { kind: 'methodcall', target: target.target, method: target.name, args };
        } else {
          throw new SyntaxError(
            `Call expression at offset ${this.peek().pos} must target a function name or a member.`,
          );
        }
      } else {
        return target;
      }
    }
  }
  private parsePrimary(): Expr {
    const t = this.peek();
    // A leading `/` in primary position can only be a Firestore path
    // literal (division needs a left operand, which primary position lacks).
    // Only `firestore.get()/exists()` accept one; anywhere else it parses
    // fine but denies at eval (see `evalExpr` 'path').
    if (t.kind === 'punct' && t.value === '/') {
      return this.parsePathArg();
    }
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

  /**
   * Parse a Firestore path literal — the `firestore.get()/exists()`
   * argument. Grammar (each segment preceded by `/`):
   *
   *   - `$(expr)`      — an interpolation resolved at eval time
   *   - `(name)`       — the parenthesized database sentinel, e.g. `(default)`
   *   - `ident`/number — a fixed path segment (`databases`, `documents`, …)
   *
   * The full path is assembled and prefix-validated at eval (see
   * `buildFirestoreDocPath`); the parser only captures structure.
   */
  private parsePathArg(): Expr {
    const segments: PathArgSegment[] = [];
    while (this.atPunct('/')) {
      this.expectPunct('/');
      if (this.atPunct('$')) {
        this.expectPunct('$');
        this.expectPunct('(');
        const expr = this.parseExpression();
        this.expectPunct(')');
        segments.push({ kind: 'interp', expr });
      } else if (this.atPunct('(')) {
        // Database sentinel like `(default)`; kept verbatim (parens included)
        // so the eval-time prefix check sees the exact production form.
        this.expectPunct('(');
        const name = this.expectIdentValue();
        this.expectPunct(')');
        segments.push({ kind: 'literal', value: `(${name})` });
      } else {
        const t = this.peek();
        if (t.kind === 'ident') {
          this.pos++;
          segments.push({ kind: 'literal', value: t.value });
        } else if (t.kind === 'number') {
          this.pos++;
          segments.push({ kind: 'literal', value: String(t.value) });
        } else {
          throw new SyntaxError(
            `Expected a path segment after '/' at offset ${t.pos}, got "${describeToken(t)}".`,
          );
        }
      }
    }
    if (segments.length === 0) {
      throw new SyntaxError(`Empty Firestore path literal at offset ${this.peek().pos}.`);
    }
    return { kind: 'path', segments };
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
  resolveFunctions(root, new Map());
  return { _root: root };
}

/**
 * Resolve each block's visible-function map (lexical scoping): a block
 * sees its ancestors' functions plus its own, with an inner declaration
 * shadowing an outer one of the same name. Each function's body is bound
 * to its declaring block's map so a call evaluates in declaration-site
 * scope regardless of where it is called from.
 */
function resolveFunctions(block: MatchBlock, parent: FunctionMap): void {
  const map: FunctionMap = new Map(parent);
  for (const fn of block.functions) map.set(fn.name, fn);
  block.visibleFuncs = map;
  for (const fn of block.functions) fn.declScope = map;
  for (const child of block.children) resolveFunctions(child, map);
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
  now: Date = new Date(),
  firestoreLookup?: FirestoreLookup,
): EvaluationResult {
  // `request.time` is the request's evaluation moment, modeled internally
  // as epoch milliseconds so it compares numerically against the
  // `timestamp.date(...)` / `timestamp.value(...)` constructors. The caller
  // injects it (deterministic in tests); it defaults to now.
  const nowMillis = now.getTime();
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
        let result: boolean;
        try {
          result = rule.condition
            ? truthy(evalExpr(rule.condition, {
                input,
                now: nowMillis,
                params: newParams,
                locals: {},
                funcs: block.visibleFuncs ?? new Map(),
                depth: 0,
                firestoreLookup,
              }))
            : true;
        } catch (err) {
          // Any function-evaluation failure (undefined function, wrong
          // arity, depth exceeded, error inside a body) denies this rule
          // with a reason that names the function — never a false allow.
          if (err instanceof RuleEvalError) {
            reasons.push(
              `match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`,
            );
            continue;
          }
          throw err;
        }
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
 * Raised when a user-defined function cannot be evaluated (undefined,
 * wrong arity, call depth exceeded, or an error surfacing from within a
 * body). Caught at the condition boundary and converted into a
 * deny-with-reason so a function failure NEVER produces a false allow,
 * matching production Storage, where evaluation errors deny.
 */
class RuleEvalError extends Error {}

/**
 * Production Storage caps function call depth (documented limit 20) and
 * effectively disallows recursion. We enforce a hard cap that errors
 * (→ deny) rather than looping forever.
 */
const MAX_CALL_DEPTH = 20;

/** Everything an expression needs to evaluate. */
interface EvalCtx {
  input: EvaluationInput;
  /** `request.time` as epoch milliseconds (injected by the caller,
   *  defaulting to evaluation-time now). */
  now: number;
  /** Path wildcards from the enclosing match. Empty inside a function
   *  body: caller wildcards do not leak in except via arguments. */
  params: Record<string, string | string[]>;
  /** Function parameter and `let` bindings for the current body. */
  locals: Record<string, unknown>;
  /** Functions callable from the current scope. */
  funcs: FunctionMap;
  /** Current call depth (0 at an allow condition). */
  depth: number;
  /** Optional Firestore read capability for `firestore.get()/exists()`.
   *  Absent in pure/test usage → those methods deny "unsupported". */
  firestoreLookup?: FirestoreLookup;
}

/**
 * Walk an `Expr` against the bindings + path params. The error
 * model is intentionally Lax: an undefined member access returns
 * `undefined` rather than throwing (mirrors what Firestore rules
 * do — a missing `resource.size` against a freshly-created object
 * is normal). `undefined` is falsy under `truthy`.
 *
 * The one place errors ARE raised is user-defined function calls
 * (`RuleEvalError`): a failure there must deny, not fall through to a
 * potentially-truthy value.
 */
function evalExpr(expr: Expr, ctx: EvalCtx): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'ident': {
      // Local (param / let) bindings win over globals and path params.
      if (expr.name in ctx.locals) return ctx.locals[expr.name];
      if (expr.name === 'request') return buildRequestObject(ctx.input, ctx.now);
      if (expr.name === 'resource') return ctx.input.resource;
      if (expr.name in ctx.params) return ctx.params[expr.name];
      return undefined;
    }
    case 'member': {
      const t = evalExpr(expr.target, ctx);
      if (t === null || t === undefined) return undefined;
      const obj = t as Record<string, unknown>;
      return obj[expr.name];
    }
    case 'index': {
      const t = evalExpr(expr.target, ctx);
      if (t === null || t === undefined) return undefined;
      const idx = evalExpr(expr.index, ctx);
      const obj = t as Record<string | number, unknown>;
      return obj[idx as string];
    }
    case 'call':
      return evalCall(expr, ctx);
    case 'methodcall':
      return evalMethodCall(expr, ctx);
    case 'path':
      // A path literal is only meaningful as a `firestore.get()/exists()`
      // argument (handled directly there). Reaching it anywhere else means
      // the rule used it out of position — deny rather than coerce.
      throw new RuleEvalError('a Firestore path literal is only valid as an argument to firestore.get()/exists()');
    case 'unary':
      return !truthy(evalExpr(expr.arg, ctx));
    case 'binary': {
      // Short-circuit && / || so half-undefined chains don't trip
      // (e.g. `request.auth != null && request.auth.uid == 'a'`).
      if (expr.op === '&&') {
        const l = evalExpr(expr.left, ctx);
        return truthy(l) ? evalExpr(expr.right, ctx) : l;
      }
      if (expr.op === '||') {
        const l = evalExpr(expr.left, ctx);
        return truthy(l) ? l : evalExpr(expr.right, ctx);
      }
      const l = evalExpr(expr.left, ctx);
      const r = evalExpr(expr.right, ctx);
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

/**
 * Evaluate a user-defined function call. Arguments are evaluated in the
 * CALLER's context, then bound to the function's parameters; the body
 * (with any `let` bindings) is evaluated in the function's own lexical
 * scope with fresh locals — caller path wildcards are not visible except
 * through the arguments passed. Every failure mode throws `RuleEvalError`
 * so the caller denies with a function-naming reason.
 */
function evalCall(expr: Extract<Expr, { kind: 'call' }>, ctx: EvalCtx): unknown {
  const fn = ctx.funcs.get(expr.name);
  if (!fn) {
    throw new RuleEvalError(`undefined function ${expr.name}()`);
  }
  if (fn.params.length !== expr.args.length) {
    throw new RuleEvalError(
      `function ${expr.name}() expects ${fn.params.length} argument(s), got ${expr.args.length}`,
    );
  }
  const depth = ctx.depth + 1;
  if (depth > MAX_CALL_DEPTH) {
    throw new RuleEvalError(
      `function ${expr.name}() exceeded max call depth ${MAX_CALL_DEPTH}`,
    );
  }
  // Arguments: caller context.
  const argVals = expr.args.map((a) => evalExpr(a, ctx));
  const locals: Record<string, unknown> = {};
  fn.params.forEach((p, i) => {
    locals[p] = argVals[i];
  });
  const bodyCtx: EvalCtx = {
    input: ctx.input,
    now: ctx.now,
    params: {}, // no dynamic-scope leakage of caller wildcards
    locals,
    funcs: fn.declScope ?? new Map(),
    depth,
    firestoreLookup: ctx.firestoreLookup,
  };
  // `let` bindings evaluated in order; each is visible to the next and
  // to the return expression (they share the `locals` object).
  for (const b of fn.lets) {
    locals[b.name] = evalExpr(b.value, bodyCtx);
  }
  return evalExpr(fn.body, bodyCtx);
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

function buildRequestObject(input: EvaluationInput, now: number): Record<string, unknown> {
  return {
    auth: input.request.auth,
    resource: input.request.resource,
    method: input.request.method,
    path: input.request.path,
    // `request.time` as epoch millis — see the timestamp constructors in
    // `evalMethodCall`, which produce the same representation so comparisons
    // like `request.time < timestamp.date(2030, 1, 1)` are plain numerics.
    time: now,
  };
}

// ═══════════════════════════════════════════════════════════════
// Builtin method / namespace calls
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate a `<target>.<method>(args)` call. Two builtin families are
 * supported; everything else denies (throws `RuleEvalError`), so unknown
 * builtins — including deliberately-out-of-scope `firestore.get`/`exists` —
 * deny with a reason rather than ever a false allow.
 *
 *   - `string.matches(re)` — RE2-style whole-string regex match.
 *   - `timestamp.date(y, m, d)` / `timestamp.value(epochMillis)` —
 *     timestamp constructors, returned as epoch millis to compare against
 *     `request.time`.
 */
function evalMethodCall(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): unknown {
  // Timestamp namespace: `timestamp.date(...)` / `timestamp.value(...)`.
  // Detected structurally on the bare `timestamp` identifier (not a bound
  // local/param/global) so a user value named `timestamp` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'timestamp' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalTimestampBuiltin(expr, ctx);
  }

  // Firestore namespace: `firestore.get(path)` / `firestore.exists(path)`.
  // Detected on the bare `firestore` identifier (not a bound local/param) so
  // a user value named `firestore` can't hijack it.
  if (
    expr.target.kind === 'ident' &&
    expr.target.name === 'firestore' &&
    !(expr.target.name in ctx.locals) &&
    !(expr.target.name in ctx.params)
  ) {
    return evalFirestoreBuiltin(expr, ctx);
  }

  if (expr.method === 'matches') {
    return evalMatches(expr, ctx);
  }

  throw new RuleEvalError(`unsupported method .${expr.method}()`);
}

/**
 * Evaluate `firestore.get(path)` / `firestore.exists(path)`.
 *
 * Requires an injected {@link FirestoreLookup} (the enforcement layer
 * supplies one from the sandbox's Firestore data). With NO capability —
 * pure/test usage without a sandbox — this denies with an "unsupported"
 * reason rather than ever a false allow, preserving the pre-lookup posture.
 *
 * Semantics (production-honest, deny-on-error):
 *   - `firestore.get(path)` → a resource `{ data: <fields> }`. Member access
 *     `.data.<field>` then reads the doc's fields. On a NONEXISTENT doc,
 *     production `get()` is itself an error, so this denies with a reason.
 *   - `firestore.exists(path)` → boolean.
 *   - Malformed path (missing `/databases/<db>/documents/` prefix, odd
 *     segment count), a non-string interpolation, wrong arg count, or a
 *     non-path argument → deny with a reason.
 */
function evalFirestoreBuiltin(
  expr: Extract<Expr, { kind: 'methodcall' }>,
  ctx: EvalCtx,
): unknown {
  if (expr.method !== 'get' && expr.method !== 'exists') {
    throw new RuleEvalError(`unsupported method firestore.${expr.method}()`);
  }
  if (!ctx.firestoreLookup) {
    // No sandbox-backed capability injected — keep the deny-with-reason
    // "unsupported" behavior; never a false allow.
    throw new RuleEvalError(
      `firestore.${expr.method}() is unsupported here — no Firestore lookup capability is configured`,
    );
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`firestore.${expr.method}() expects a single path argument`);
  }
  const arg = expr.args[0];
  if (arg.kind !== 'path') {
    throw new RuleEvalError(`firestore.${expr.method}() requires a /databases/.../documents/... path literal`);
  }
  const docPath = buildFirestoreDocPath(arg, ctx);
  if (expr.method === 'exists') {
    return ctx.firestoreLookup.exists(docPath);
  }
  const fields = ctx.firestoreLookup.get(docPath);
  if (fields === null) {
    // Production: `get()` on a missing document errors, and errors deny.
    throw new RuleEvalError(`firestore.get() targeted a nonexistent document: ${docPath}`);
  }
  return { data: fields };
}

/**
 * Assemble a {@link PathArgSegment} list into the document path the
 * {@link FirestoreLookup} expects, then validate + strip the required
 * `/databases/<db>/documents/` prefix. Interpolations must resolve to a
 * string or number; anything else (e.g. `request.auth.uid` when auth is
 * null → undefined) throws → deny.
 */
function buildFirestoreDocPath(
  pathExpr: Extract<Expr, { kind: 'path' }>,
  ctx: EvalCtx,
): string {
  const parts = pathExpr.segments.map((seg) => {
    if (seg.kind === 'literal') return seg.value;
    const v = evalExpr(seg.expr, ctx);
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    throw new RuleEvalError(
      `Firestore path interpolation resolved to ${describeType(v)} (expected a string)`,
    );
  });
  // Required production shape: databases / <db> / documents / <doc path…>.
  if (parts.length < 4 || parts[0] !== 'databases' || parts[2] !== 'documents') {
    throw new RuleEvalError(
      `malformed Firestore path — expected /databases/<db>/documents/... , got /${parts.join('/')}`,
    );
  }
  const docSegments = parts.slice(3);
  // A document path is collection/doc pairs — an even, non-zero segment count.
  if (docSegments.length === 0 || docSegments.length % 2 !== 0) {
    throw new RuleEvalError(
      `Firestore path does not point at a document (needs an even segment count): ${docSegments.join('/')}`,
    );
  }
  return docSegments.join('/');
}

/** `timestamp.date(year, month, day)` (UTC midnight) and
 *  `timestamp.value(epochMillis)`, both returning epoch milliseconds. */
function evalTimestampBuiltin(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): number {
  const args = expr.args.map((a) => evalExpr(a, ctx));
  if (expr.method === 'value') {
    if (args.length !== 1 || typeof args[0] !== 'number') {
      throw new RuleEvalError(`timestamp.value() expects (epochMillis: number)`);
    }
    return args[0];
  }
  if (expr.method === 'date') {
    if (args.length !== 3 || !args.every((a) => typeof a === 'number')) {
      throw new RuleEvalError(`timestamp.date() expects (year, month, day) numbers`);
    }
    const [y, m, d] = args as [number, number, number];
    // Production `timestamp.date(y, m, d)` is UTC midnight; month is 1-based.
    return Date.UTC(y, m - 1, d);
  }
  throw new RuleEvalError(`unsupported timestamp.${expr.method}()`);
}

/**
 * `string.matches(re)` — regex match anchored to the WHOLE string, mirroring
 * production Storage (which anchors implicitly, so `'abc'.matches('a')` is
 * FALSE).
 *
 * RE2-vs-JS divergence (honest note): production runs RE2, we compile the
 * pattern with JavaScript's `RegExp`. JS RegExp is a superset of RE2 —
 * backreferences (`\1`) and lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) work in
 * JS but are UNSUPPORTED in RE2 and would fail in production. To avoid ever
 * false-allowing on a pattern production would reject, those constructs are
 * detected up front and denied. Invalid patterns (that even JS won't compile)
 * also deny. A non-string target (e.g. a missing metadata key → undefined)
 * denies too — production would error, and an error denies.
 */
function evalMatches(expr: Extract<Expr, { kind: 'methodcall' }>, ctx: EvalCtx): boolean {
  const subject = evalExpr(expr.target, ctx);
  if (typeof subject !== 'string') {
    throw new RuleEvalError(`matches() requires a string target, got ${describeType(subject)}`);
  }
  if (expr.args.length !== 1) {
    throw new RuleEvalError(`matches() expects a single pattern argument`);
  }
  const pattern = evalExpr(expr.args[0], ctx);
  if (typeof pattern !== 'string') {
    throw new RuleEvalError(`matches() pattern must be a string`);
  }
  // Detect RE2-unsupported constructs JS would happily (mis)compile.
  const backref = /\\[1-9]/.test(pattern);
  const lookaround = /\(\?<?[=!]/.test(pattern);
  if (backref || lookaround) {
    throw new RuleEvalError(
      `matches() pattern uses an RE2-unsupported construct (${backref ? 'backreference' : 'lookaround'}) that production would reject`,
    );
  }
  let re: RegExp;
  try {
    // Anchor to the whole string. `(?:...)` keeps the caller's alternations
    // from binding past the anchors.
    re = new RegExp(`^(?:${pattern})$`);
  } catch (err) {
    throw new RuleEvalError(`matches() invalid regex pattern: ${(err as Error).message}`);
  }
  return re.test(subject);
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return typeof v;
}
