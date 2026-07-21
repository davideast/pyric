/**
 * Storage rules — shared syntax, storage-specific evaluation.
 *
 * Firebase Security Rules is ONE language across Firestore and Storage.
 * Parsing goes through the shared Ohm grammar
 * (`../../rules/grammar/FirestoreRules.ohm`), whose syntax layer is
 * service-agnostic; a converter in this module maps the shared AST into
 * the evaluator's internal shapes. What is genuinely storage-specific —
 * and why this module keeps its OWN evaluator — is the binding layer:
 * `request.resource.size` / `contentType`, `resource.metadata`, the GCS
 * object-identity fields, and the error-value semantics probed against
 * production Storage. Firestore's evaluator is instead shaped around
 * `resource.data` and document snapshots.
 *
 * Evaluation surface:
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
 *       literals: number (int + float), string (with escapes), boolean,
 *         null, list, map
 *       identifiers: `request`, `resource`, plus path parameters
 *       member access (`a.b`), index access (`a['b']`), slice (`a[x:y]`)
 *       unary: `!`, `-`
 *       binary: `&& || == != < > <= >= + - * / %`
 *       ternary `?:`, `in` (list membership / map keys), `is` (type test)
 *       parens
 *       user-defined function calls (`isOwner(uid)`)
 *       `request.time` compared against the timestamp constructors
 *         `timestamp.date(y, m, d)` (UTC midnight) and
 *         `timestamp.value(epochMillis)`. The caller injects the time
 *         (3rd arg to `evaluateStorageRules`), defaulting to now.
 *       `duration.value(n, unit)` — a duration in millis, so the freshness
 *         idiom `request.time < resource.timeCreated + duration.value(1, 'h')`
 *         evaluates.
 *       `string.matches(re)` — whole-string RE2-style regex match
 *         (see `evalMatches` for the RE2-vs-JS divergence handling)
 *       custom-metadata access in both dotted (`resource.metadata.owner`)
 *         and bracket (`resource.metadata['owner']`) form — the metadata
 *         map is a plain string→string object, so both resolve identically
 *         and a missing key is `undefined` (falsy → deny).
 *   - `function name(params) { let …; return expr; }` declarations at
 *     global scope, service scope, or inside a `match` block (with
 *     optional `export`). Lexically scoped (visible
 *     within the declaring block and nested blocks; inner shadows
 *     outer), may call other functions, support `let` bindings, and are
 *     depth-capped. Any function-eval failure denies with a reason.
 *
 *   - The object-identity / time fields of `resource`: `name` (the FULL object
 *     path, GCS convention — not the client SDK's last-segment `name`),
 *     `bucket`, `timeCreated`, `updated`, `generation`, `metageneration`. They
 *     are sourced from the persisted object record (see `resourceFromStored`),
 *     which already carries every one of them. There is no `resource.timeUpdated`
 *     in the language; the update-time field is `updated`.
 *
 * ERROR SEMANTICS (live-probed against the production Rules Test API — see
 * `RuleError`): reading a property that is ABSENT, or dereferencing a null,
 * yields an error VALUE that absorbs to DENY and SURVIVES NEGATION. Modeling
 * it as a plain `undefined` would false-allow `resource.name != 'x'` on an
 * object with no `name`; production denies it.
 *
 * Still out of scope: the content-hash fields (`md5Hash`, `crc32c`, `etag`) and
 * the remaining content-* fields. Unknown builtins deny with a reason rather
 * than false-allow. Hooks for adding more live at the obvious extension seams in
 * the parser + evaluator.
 */

import { parseToASTOrError } from '../../rules/grammar/FirestoreParser.js';
// RULES-B5 float model, shared with the Firestore simulator: a FLOAT value is
// tagged with this wrapper while a bare JS `number` means INT (see the
// wrapper's header for why floats are the wrapped case). The storage evaluator
// adopts the same model so `1.0 is float`, truncating int division, and
// int-vs-float promotion match production instead of JS numerics.
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import type {
  FirestoreRules as SharedRules,
  MatchBlock as SharedMatchBlock,
  PathSegment as SharedPathSegment,
  FunctionDef as SharedFunctionDef,
  Expression as SharedExpression,
} from '../../rules/grammar/FirestoreAST.js';

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
export function expandVerb(verb: StorageGrantVerb | StorageRequestMethod): StorageVerb[] {
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

/**
 * Existing-object bindings (for `resource.*`). `null` when no object exists
 * yet (creates).
 *
 * The object-identity/time fields carry GOOGLE CLOUD STORAGE semantics, not
 * the client SDK's `FullMetadata` semantics — the two disagree on `name`:
 *
 *   - rules `resource.name` is the object's FULL path within the bucket
 *     (`uploads/pic.png`), the GCS object-name convention. The client SDK's
 *     `FullMetadata.name` is the LAST path segment (`pic.png`). The adapter
 *     (`resourceFromStored`) therefore sources `name` from the persisted
 *     record's `fullPath`, NOT its `name`.
 *   - `timeCreated` / `updated` are ISO-8601 strings here (the persisted
 *     shape); the evaluator converts them to epoch millis when it builds the
 *     binding, so they compare numerically against `request.time` and against
 *     each other. Production types them as `timestamp` and rejects an int in
 *     their place ("Received: int < timestamp").
 *   - The update-time field is `updated`. There is NO `resource.timeUpdated`
 *     in the Storage rules language.
 *
 * A field left `undefined` reads as ABSENT, which production treats as an
 * evaluation error that denies (see {@link RuleError}).
 */
export interface StorageResource {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  /** Full object path within the bucket, e.g. `uploads/pic.png`. */
  name?: string;
  /** Bucket the object lives in. */
  bucket?: string;
  /** ISO-8601 creation time. */
  timeCreated?: string;
  /** ISO-8601 time of the most recent content/metadata update. */
  updated?: string;
  /** Content generation (production types it `int`). */
  generation?: number;
  /** Metadata generation (production types it `int`). */
  metageneration?: number;
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

export interface MatchBlock {
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
export interface FunctionDef {
  name: string;
  params: string[];
  /** `let` bindings evaluated in order before the return, each visible
   *  to those after it and to the return expression. */
  lets: { name: string; value: Expr }[];
  body: Expr;
  /** Set for a name brought in by an `import` declaration: the module
   *  specifier. The syntax parses, but module resolution is not implemented,
   *  so calling the function denies with a reason naming the import — not a
   *  bare "undefined function". A same-named locally-declared function
   *  shadows the stub (stubs are registered first). */
  unresolvedImport?: string;
  /** Lexical scope: the functions visible from this function's body
   *  (its declaring block's `visibleFuncs`). Resolved after parsing so
   *  a call's body uses declaration-site scope, not the caller's. */
  declScope?: FunctionMap;
}

export type FunctionMap = Map<string, FunctionDef>;

export type PathSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'wildcard'; name: string };

export interface AllowRule {
  verbs: StorageGrantVerb[];
  condition: Expr | null;
}

export type BinaryOp =
  | '&&' | '||' | '==' | '!=' | '<' | '>' | '<=' | '>='
  | '+' | '-' | '*' | '/' | '%';

/** Runtime twin of {@link BinaryOp} — the converter validates grammar
 *  operator strings against this set so a new operator fails the parse
 *  loudly rather than converting silently (see convertExpr's binaryOp case). */
const BINARY_OPS: ReadonlySet<BinaryOp> = new Set([
  '&&', '||', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%',
]);

export type Expr =
  | { kind: 'literal'; value: number | RulesFloat | string | boolean | null }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; target: Expr; name: string }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'slice'; target: Expr; start: Expr; end: Expr }
  | { kind: 'unary'; op: '!' | '-'; arg: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'in'; element: Expr; collection: Expr }
  | { kind: 'is'; value: Expr; typeName: string }
  | { kind: 'list'; elements: Expr[] }
  | { kind: 'map'; entries: { key: Expr; value: Expr }[] }
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
export type PathArgSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'interp'; expr: Expr };

// ═══════════════════════════════════════════════════════════════
// Shared-grammar front end
// ═══════════════════════════════════════════════════════════════
//
// Storage rules are parsed by the SAME Ohm grammar as Firestore rules
// (Firebase Security Rules is one language; the grammar's serviceName
// and Operation productions are service-agnostic). The functions below
// convert the shared AST into this module's internal shapes, which the
// evaluator consumes. The expression converter is exhaustive over the
// shared Expression union, so a construct added to the grammar without
// a storage mapping fails loudly at parse time instead of drifting
// silently.

function convertMatch(block: SharedMatchBlock): MatchBlock {
  return {
    segments: block.path.segments.map(convertSegment),
    children: block.children.map(convertMatch),
    allows: block.allows.map((a) => ({
      verbs: a.operations,
      condition: convertExpr(a.condition),
    })),
    functions: block.functions.map(convertFunction),
  };
}

function convertSegment(seg: SharedPathSegment): PathSegment {
  switch (seg.type) {
    case 'literal': return { kind: 'literal', value: seg.value };
    case 'wildcard': return { kind: 'param', name: seg.name };
    case 'recursive': return { kind: 'wildcard', name: seg.name };
  }
}

function convertFunction(fn: SharedFunctionDef): FunctionDef {
  return {
    name: fn.name,
    params: fn.parameters,
    lets: fn.lets.map((l) => ({ name: l.name, value: convertExpr(l.value) })),
    body: convertExpr(fn.body),
  };
}

function convertExpr(e: SharedExpression): Expr {
  switch (e.type) {
    case 'literal':
      // A numeric literal written with a decimal point is a FLOAT even when
      // integral (`1.0`); the grammar preserves the source text in `raw`, so
      // a `.` there is the float signal. Bare integer literals stay raw
      // numbers (= int), mirroring the simulator's literal handling.
      if (typeof e.value === 'number' && e.raw.includes('.')) {
        return { kind: 'literal', value: new RulesFloat(e.value) };
      }
      return { kind: 'literal', value: e.value };
    case 'identifier':
      return { kind: 'ident', name: e.name };
    case 'memberAccess':
      return { kind: 'member', target: convertExpr(e.object), name: e.property };
    case 'methodCall':
      return { kind: 'methodcall', target: convertExpr(e.object), method: e.method, args: e.args.map(convertExpr) };
    case 'bracketAccess':
      return { kind: 'index', target: convertExpr(e.object), index: convertExpr(e.index) };
    case 'sliceAccess':
      return { kind: 'slice', target: convertExpr(e.object), start: convertExpr(e.start), end: convertExpr(e.end) };
    case 'binaryOp':
      // Operator strings are VALIDATED, not cast: the `never` backstop below
      // only catches new Expression VARIANTS — a new operator on an existing
      // variant would otherwise convert silently and fall off evalExpr's op
      // switch to an undefined (silent deny), recreating the drift class the
      // shared-grammar move exists to kill. Fail the parse loudly instead.
      if (!BINARY_OPS.has(e.op as BinaryOp)) {
        throw new SyntaxError(`Unsupported binary operator '${e.op}' in storage rules.`);
      }
      return { kind: 'binary', op: e.op as BinaryOp, left: convertExpr(e.left), right: convertExpr(e.right) };
    case 'unaryOp':
      if (e.op !== '!' && e.op !== '-') {
        throw new SyntaxError(`Unsupported unary operator '${e.op}' in storage rules.`);
      }
      return { kind: 'unary', op: e.op, arg: convertExpr(e.operand) };
    case 'ternary':
      return { kind: 'ternary', cond: convertExpr(e.condition), then: convertExpr(e.consequent), else: convertExpr(e.alternate) };
    case 'inExpr':
      return { kind: 'in', element: convertExpr(e.element), collection: convertExpr(e.collection) };
    case 'isExpr':
      return { kind: 'is', value: convertExpr(e.value), typeName: e.typeName };
    case 'listLiteral':
      return { kind: 'list', elements: e.elements.map(convertExpr) };
    case 'mapLiteral':
      return { kind: 'map', entries: e.entries.map((en) => ({ key: convertExpr(en.key), value: convertExpr(en.value) })) };
    case 'pathLiteral':
      return {
        kind: 'path',
        segments: e.segments.map((seg): PathArgSegment =>
          typeof seg === 'string'
            ? { kind: 'literal', value: seg }
            : { kind: 'interp', expr: convertExpr(seg) },
        ),
      };
    case 'functionCall':
      return { kind: 'call', name: e.name, args: e.args.map(convertExpr) };
    default: {
      // Exhaustiveness backstop: a NEW grammar construct with no storage
      // mapping must fail the parse, never evaluate wrong.
      const unhandled: never = e;
      throw new SyntaxError(`Unsupported expression construct: ${JSON.stringify(unhandled)}`);
    }
  }
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
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    throw new SyntaxError(
      `Storage rules parse error at line ${parsed.error.line}, column ${parsed.error.column}: expected ${parsed.error.expected}.`,
    );
  }
  const ast: SharedRules = parsed.ast;
  if (ast.service.name !== 'firebase.storage') {
    throw new SyntaxError(
      `Expected 'service firebase.storage', got 'service ${ast.service.name}'.`,
    );
  }
  // The service's own DocumentsMatch (`match /b/{bucket}/o`) becomes a child
  // of a synthetic path-less root so path matching starts at the request
  // path's first segment, as before.
  //
  // Global and service-scope function declarations attach to the root block:
  // root visibility equals everywhere-in-service visibility, and the array
  // order (global, then service, then none of root's own) preserves
  // inner-shadows-outer resolution in `resolveFunctions`.
  const root: MatchBlock = {
    segments: [],
    children: [convertMatch(ast.service.match)],
    allows: [],
    functions: [
      // Import stubs FIRST so any real declaration of the same name
      // shadows them in resolveFunctions (later map.set wins).
      ...(ast.imports ?? []).flatMap((imp) =>
        imp.functions.map((name): FunctionDef => ({
          name,
          params: [],
          lets: [],
          body: { kind: 'literal', value: null },
          unresolvedImport: imp.module,
        })),
      ),
      ...(ast.functions ?? []).map(convertFunction),
      ...(ast.service.functions ?? []).map(convertFunction),
    ],
  };
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
