/**
 * Rules-language analyzer (issue #185, step 2).
 *
 * Given ruleset source (Firestore / Storage) or a rules JSON string (RTDB),
 * returns the set of language-construct ids the ruleset EXERCISES, by walking
 * the ASTs the existing parsers already produce — no new parsing. The
 * construct ids are exactly those enumerated in the per-engine language
 * snapshots (rules-language/<engine>.json).
 *
 * This is the numerator producer for the "verified coverage" axis: run the
 * analyzer over every production-captured corpus scenario, and a construct is
 * verified iff some scenario that has an observation twin exercises it.
 *
 * Attribution is deliberately CONSERVATIVE. Method calls whose receiver type
 * cannot be determined from the AST (e.g. a bare `size()` on a value of
 * unknown type, ambiguous across string/list/map/set/bytes) are NOT credited
 * to any construct — they are surfaced as `unresolved` diagnostics instead.
 * Under-counting is honest; over-counting would inflate the trust number the
 * issue is built to protect. The same bar applies to `duration.seconds`/
 * `duration.nanos` vs `timestamp.seconds`/`timestamp.nanos` (same method
 * names, disambiguated only by proving the receiver's type — a namespace
 * constructor, a `request.time`-rooted access, or sound Timestamp/Duration
 * arithmetic — never by guessing) and to the `&&`/`||` error-absorption
 * semantics (credited only from a genuine AST signature: a risky operand
 * FIRST, paired with the absorbing boolean literal SECOND — see `fsIsRisky`).
 *
 * Some snapshot constructs are not merely hard to attribute today but
 * PERMANENTLY unattributable by this method: a pure meta-semantic with no
 * expression-level AST representation (e.g. `storage.semantic.deny-by-default`,
 * `rtdb.semantic.deny-by-default` — ambient engine behavior, not something a
 * ruleset's source text contains). Those constructs carry `unattributable` in
 * their snapshot entry and are excluded from the coverage denominator rather
 * than left looking like an ordinary, someday-closeable gap.
 *
 * SOURCE IS NOT THE ONLY EVIDENCE. Everything above is the SYNTACTIC path: find
 * the construct's node in a captured scenario's ruleset. A construct that IS a
 * behavior of the engine rather than a token of the language (the RTDB cascade
 * semantics: a truthy ancestor `.read`/`.write` grants below it; `.validate`
 * does not cascade) has no node to find and would read 0% verified forever,
 * even though production's captured VERDICTS prove it. Such a construct is
 * credited BEHAVIORALLY, from a `conforms` + `oracle-backed` rules-engine
 * registry row whose `constructs` scope lists it. Both paths, and the honesty
 * line separating a creditable cascade grant from an uncreditable
 * deny-by-default non-event, live in `production-verification.ts`; this file
 * supplies the syntactic half and calls that predicate for the verdict.
 *
 * Also exposes the computed coverage-report writer (run as a script) that walks
 * every corpus scenario and emits rules-language/coverage-report.json.
 */
import * as ohm from 'ohm-js';
import {
  parseToASTOrError,
} from '../../../packages/pyric/src/rules/grammar/FirestoreParser.ts';
import type {
  Expression,
  FirestoreRules,
  MatchBlock,
} from '../../../packages/pyric/src/rules/grammar/FirestoreAST.ts';
import { parseStorageRules } from '../../../packages/pyric/src/storage/rules.ts';
import { grammar as rtdbGrammar } from '../../../packages/pyric/src/database/grammar/RtdbExprParser.ts';
import { loadSnapshot, type RulesEngine } from '../rules-language/load.ts';
import { surfaceRegistries } from '../registry/index.ts';
import { indexConstructScopes, isProductionVerified } from './production-verification.ts';

// ── Result shape ──────────────────────────────────────────────────────

export interface UnresolvedRef {
  /** What could not be attributed (e.g. `method:size`). */
  what: string;
  /** Why (e.g. `receiver type unknown, name ambiguous across map/list/set`). */
  reason: string;
}

export interface AnalyzeResult {
  /** Construct ids exercised (all present in the engine snapshot). */
  ids: Set<string>;
  /** Constructs seen but not attributable to a single snapshot id. */
  unresolved: UnresolvedRef[];
}

// ════════════════════════════════════════════════════════════════════
// FIRESTORE
// ════════════════════════════════════════════════════════════════════

const FS_NAMESPACES = new Set(['math', 'timestamp', 'duration', 'latlng', 'hashing']);
const FS_CASTS = new Set(['string', 'int', 'float', 'bool', 'path']);
const FS_BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'debug']);

const FS_BINOP: Record<string, string> = {
  '==': 'eq', '!=': 'neq', '<': 'lt', '>': 'gt', '<=': 'lte', '>=': 'gte',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
  '&&': 'and', '||': 'or',
};

/** Return type of a method, keyed by the method name where it is unambiguous
 *  enough to type an outer receiver. Used only to infer the receiver type of a
 *  CHAINED method call. */
const FS_METHOD_RETURNS: Record<string, string> = {
  split: 'list', toUtf8: 'bytes', lower: 'string', upper: 'string', trim: 'string', replace: 'string',
  toSet: 'set', concat: 'list', removeAll: 'list', join: 'string',
  keys: 'set', values: 'list', diff: 'mapdiff',
  difference: 'set', union: 'set', intersection: 'set',
  addedKeys: 'set', removedKeys: 'set', changedKeys: 'set', affectedKeys: 'set', unchangedKeys: 'set',
  toBase64: 'string', toHexString: 'string',
  bind: 'path',
};

/** Return type of a NAMESPACE function call (`duration.value(...)`,
 *  `timestamp.date(...)`, …), keyed by `[namespace][functionName]`. This is
 *  what lets a chained call like `duration.time(1, 0, 0, 0).seconds()` (or a
 *  timestamp difference, see the `binaryOp` case below) type its outer
 *  `.seconds()`/`.nanos()` receiver as `duration` rather than falling back to
 *  the ambiguous `timestamp`-or-`duration` ANY-candidate case, which stays
 *  unresolved by design. Only the namespaces/functions that can produce a
 *  `duration` or `timestamp` value are listed — `math`/`hashing` are out of
 *  scope for this receiver-type distinction. */
const FS_NAMESPACE_RETURNS: Record<string, Record<string, string>> = {
  duration: { value: 'duration', time: 'duration', abs: 'duration' },
  timestamp: { value: 'timestamp', date: 'timestamp' },
  latlng: { value: 'latlng' },
};

/** Snapshot-derived method-name → candidate receiver types, for the
 *  unique-name fallback and ambiguity reporting. Built lazily. */
let _fsMethodIndex: Map<string, string[]> | null = null;
function fsMethodIndex(): Map<string, string[]> {
  if (_fsMethodIndex) return _fsMethodIndex;
  const idx = new Map<string, string[]>();
  for (const c of loadSnapshot('firestore').constructs) {
    if (c.kind !== 'method' || !c.receiverType) continue;
    const name = c.id.split('.').pop()!;
    const arr = idx.get(name) ?? [];
    arr.push(c.receiverType);
    idx.set(name, arr);
  }
  _fsMethodIndex = idx;
  return idx;
}

/** Best-effort static type of a Firestore expression; null when unknown. */
function fsInferType(e: Expression): string | null {
  switch (e.type) {
    case 'literal':
      if (typeof e.value === 'string') return 'string';
      if (typeof e.value === 'number') return 'number';
      if (typeof e.value === 'boolean') return 'bool';
      return null;
    case 'listLiteral':
      return 'list';
    case 'mapLiteral':
      return 'map';
    case 'memberAccess': {
      const p = e.property;
      if (p === 'data' || p === 'token' || p === 'auth' || p === 'query') return 'map';
      if (p === 'id') return 'string';
      if (p === 'time') return 'timestamp';
      if (p === 'path' || p === '__name__') return 'path';
      return null;
    }
    case 'methodCall':
      // A namespace CONSTRUCTOR call (`duration.value(...)`, `timestamp.date(...)`)
      // types by [namespace][function] — this is what makes a receiver like
      // `duration.time(1, 0, 0, 0)` provably a duration rather than unknown.
      // Anything else is a CHAINED call on some other receiver, typed (if at
      // all) by its own return-type table.
      if (e.object.type === 'identifier' && FS_NAMESPACES.has(e.object.name)) {
        return FS_NAMESPACE_RETURNS[e.object.name]?.[e.method] ?? null;
      }
      return FS_METHOD_RETURNS[e.method] ?? null;
    case 'functionCall':
      if (e.name === 'get' || e.name === 'getAfter') return 'map';
      if (FS_CASTS.has(e.name)) return e.name === 'int' || e.name === 'float' ? 'number' : e.name;
      return null;
    case 'ternary':
      return fsInferType(e.consequent) ?? fsInferType(e.alternate);
    case 'binaryOp': {
      // Timestamp/Duration cross-type arithmetic (rules.Timestamp /
      // rules.Duration operator overloads): this is what lets a timestamp
      // DIFFERENCE like `(request.time - timestamp.value(0))` type as a
      // duration receiver for a following `.seconds()`/`.nanos()` call. Both
      // operands must themselves be PROVABLY typed (e.g. `request.time`, or
      // another namespace constructor) — an operand of unknown type (an
      // arbitrary `resource.data.foo` field, say) makes the whole
      // subtraction's type unknown too, same as any other unresolved case.
      // Only the operand-type combinations the language actually defines are
      // typed; anything else (e.g. plain numeric arithmetic) stays
      // unresolved rather than guessed.
      if (e.op !== '+' && e.op !== '-') return null;
      const lt = fsInferType(e.left);
      const rt = fsInferType(e.right);
      if (e.op === '-') {
        if (lt === 'timestamp' && rt === 'timestamp') return 'duration';
        if (lt === 'timestamp' && rt === 'duration') return 'timestamp';
        if (lt === 'duration' && rt === 'duration') return 'duration';
        return null;
      }
      // e.op === '+'
      if (lt === 'timestamp' && rt === 'duration') return 'timestamp';
      if (lt === 'duration' && rt === 'timestamp') return 'timestamp';
      if (lt === 'duration' && rt === 'duration') return 'duration';
      return null;
    }
    default:
      return null;
  }
}

/**
 * Structural (not runtime) test for whether an expression subtree CAN error
 * at evaluation: an arbitrary-key access into a map-typed value (`data.foo`,
 * `get(...).data.foo` — CEL map indexing by `.` throws on a missing key,
 * unlike a JS-style undefined), or a `get`/`getAfter` call itself (which
 * throws outright when the target document does not exist). This is the
 * signature the `&&`/`||` error-absorption semantic needs an operand to
 * carry: the special (non-JS) rule only has observable effect when the
 * operand that COULD throw is paired with a boolean literal that resolves
 * the whole expression regardless.
 *
 * Deliberately does NOT recurse into a nested `&&`/`||`: that subexpression
 * resolves to its own boolean (or its own, separately-credited, absorption)
 * before it ever reaches this operator, so whether IT contains a risky access
 * several levels down says nothing about whether THIS operator's absorption
 * rule is what's in play.
 */
function fsIsRisky(e: Expression): boolean {
  switch (e.type) {
    case 'literal':
    case 'identifier':
      return false;
    case 'memberAccess':
      return fsInferType(e.object) === 'map' || fsIsRisky(e.object);
    case 'methodCall':
      return fsIsRisky(e.object) || e.args.some(fsIsRisky);
    case 'bracketAccess':
      return fsIsRisky(e.object) || fsIsRisky(e.index);
    case 'sliceAccess':
      return fsIsRisky(e.object) || fsIsRisky(e.start) || fsIsRisky(e.end);
    case 'binaryOp':
      if (e.op === '&&' || e.op === '||') return false;
      return fsIsRisky(e.left) || fsIsRisky(e.right);
    case 'unaryOp':
      return fsIsRisky(e.operand);
    case 'ternary':
      return fsIsRisky(e.condition) || fsIsRisky(e.consequent) || fsIsRisky(e.alternate);
    case 'inExpr':
      return fsIsRisky(e.element) || fsIsRisky(e.collection);
    case 'isExpr':
      return fsIsRisky(e.value);
    case 'listLiteral':
      return e.elements.some(fsIsRisky);
    case 'mapLiteral':
      return e.entries.some(({ key, value }) => fsIsRisky(key) || fsIsRisky(value));
    case 'pathLiteral':
      return e.segments.some((seg) => typeof seg !== 'string' && fsIsRisky(seg));
    case 'functionCall':
      if (e.name === 'get' || e.name === 'getAfter') return true;
      return e.args.some(fsIsRisky);
    default:
      return false;
  }
}

/** True for the literal boolean `value` (used to spot the absorbing operand:
 *  `false` for `&&`, `true` for `||`). */
function fsIsBoolLiteral(e: Expression, value: boolean): boolean {
  return e.type === 'literal' && typeof e.value === 'boolean' && e.value === value;
}

function fsWalkExpr(e: Expression, out: AnalyzeResult): void {
  const add = (id: string) => out.ids.add(id);
  switch (e.type) {
    case 'literal':
      return;
    case 'identifier':
      if (e.name === 'request') add('firestore.binding.request');
      else if (e.name === 'resource') add('firestore.binding.resource');
      return;
    case 'memberAccess': {
      add('firestore.operator.member');
      const path = fsDottedPath(e);
      if (path) {
        const id = `firestore.binding.${path}`;
        if (fsBindingIds().has(id)) add(id);
        // Always credit the base global if the chain roots at one.
        if (path.startsWith('request')) add('firestore.binding.request');
        if (path.startsWith('resource')) add('firestore.binding.resource');
      }
      fsWalkExpr(e.object, out);
      return;
    }
    case 'methodCall': {
      // Namespace function call (math.abs, timestamp.date, …)?
      if (e.object.type === 'identifier' && FS_NAMESPACES.has(e.object.name)) {
        add(`firestore.function.${e.object.name}.${e.method}`);
      } else {
        fsAttributeMethod(e, out);
      }
      fsWalkExpr(e.object, out);
      for (const a of e.args) fsWalkExpr(a, out);
      return;
    }
    case 'bracketAccess':
      add('firestore.operator.index');
      fsWalkExpr(e.object, out);
      fsWalkExpr(e.index, out);
      return;
    case 'sliceAccess':
      add('firestore.operator.slice');
      fsWalkExpr(e.object, out);
      fsWalkExpr(e.start, out);
      fsWalkExpr(e.end, out);
      return;
    case 'binaryOp': {
      const op = FS_BINOP[e.op];
      if (op) add(`firestore.operator.${op}`);
      // Error-absorption: CEL's &&/|| are commutative error-absorbing
      // operators (`error && false` → false, `error || true` → true), NOT
      // JS-style left-to-right short-circuit. The only AST shape that PROVES
      // this special (non-short-circuit) rule is in play — as opposed to
      // ordinary short-circuit, which needs no special semantic — is the
      // risky operand appearing FIRST (left), where plain left-to-right
      // evaluation would otherwise propagate its error, paired with the
      // absorbing literal on the right. (`false && risky` / `true || risky`
      // are the JS-compatible direction: ordinary short-circuit already
      // explains those without invoking absorption, so they are not
      // credited here.)
      if (e.op === '&&' && fsIsRisky(e.left) && fsIsBoolLiteral(e.right, false)) {
        add('firestore.semantic.error-absorption-and');
      }
      if (e.op === '||' && fsIsRisky(e.left) && fsIsBoolLiteral(e.right, true)) {
        add('firestore.semantic.error-absorption-or');
      }
      fsWalkExpr(e.left, out);
      fsWalkExpr(e.right, out);
      return;
    }
    case 'unaryOp':
      add(e.op === '!' ? 'firestore.operator.not' : 'firestore.operator.unary-minus');
      fsWalkExpr(e.operand, out);
      return;
    case 'ternary':
      add('firestore.operator.ternary');
      fsWalkExpr(e.condition, out);
      fsWalkExpr(e.consequent, out);
      fsWalkExpr(e.alternate, out);
      return;
    case 'inExpr':
      add('firestore.operator.in');
      fsWalkExpr(e.element, out);
      fsWalkExpr(e.collection, out);
      return;
    case 'isExpr':
      add('firestore.operator.is');
      fsWalkExpr(e.value, out);
      return;
    case 'listLiteral':
      for (const el of e.elements) fsWalkExpr(el, out);
      return;
    case 'mapLiteral':
      for (const { key, value } of e.entries) {
        fsWalkExpr(key, out);
        fsWalkExpr(value, out);
      }
      return;
    case 'pathLiteral':
      for (const seg of e.segments) if (typeof seg !== 'string') fsWalkExpr(seg, out);
      return;
    case 'functionCall':
      if (FS_BUILTINS.has(e.name)) add(`firestore.function.${e.name}`);
      else if (FS_CASTS.has(e.name)) add(`firestore.function.cast.${e.name}`);
      for (const a of e.args) fsWalkExpr(a, out);
      return;
  }
}

let _fsBindingIds: Set<string> | null = null;
function fsBindingIds(): Set<string> {
  if (_fsBindingIds) return _fsBindingIds;
  _fsBindingIds = new Set(loadSnapshot('firestore').constructs.filter((c) => c.kind === 'binding').map((c) => c.id));
  return _fsBindingIds;
}

/** Build a dotted path like `request.auth.uid` from a memberAccess chain
 *  rooted at an identifier; null when it does not root at a plain identifier. */
function fsDottedPath(e: Expression): string | null {
  if (e.type === 'identifier') return e.name;
  if (e.type === 'memberAccess') {
    const base = fsDottedPath(e.object);
    return base ? `${base}.${e.property}` : null;
  }
  return null;
}

function fsAttributeMethod(e: Extract<Expression, { type: 'methodCall' }>, out: AnalyzeResult): void {
  const recv = fsInferType(e.object);
  if (recv) {
    const id = `firestore.method.${recv}.${e.method}`;
    if (fsMethodIndex().get(e.method)?.includes(recv)) {
      out.ids.add(id);
      return;
    }
  }
  const candidates = fsMethodIndex().get(e.method);
  if (candidates && candidates.length === 1) {
    out.ids.add(`firestore.method.${candidates[0]}.${e.method}`);
    return;
  }
  out.unresolved.push({
    what: `method:${e.method}`,
    reason: candidates
      ? `receiver type ${recv ?? 'unknown'}; name ambiguous across ${candidates.join('/')}`
      : `unknown method (not in firestore snapshot)`,
  });
}

function fsWalkMatch(block: MatchBlock, depth: number, out: AnalyzeResult): void {
  out.ids.add('firestore.rule-kind.match');
  if (depth > 0) out.ids.add('firestore.semantic.hierarchical-match-cascade');
  for (const seg of block.path.segments) {
    if (seg.type === 'recursive') out.ids.add('firestore.semantic.recursive-wildcard');
    if (seg.type === 'wildcard' || seg.type === 'recursive') out.ids.add('firestore.binding.path-variable');
  }
  for (const fn of block.functions) {
    out.ids.add('firestore.rule-kind.function');
    if (fn.lets.length > 0) out.ids.add('firestore.rule-kind.let');
    for (const l of fn.lets) fsWalkExpr(l.value, out);
    fsWalkExpr(fn.body, out);
  }
  for (const allow of block.allows) {
    for (const op of allow.operations) out.ids.add(`firestore.rule-kind.allow-${op}`);
    fsWalkExpr(allow.condition, out);
  }
  for (const child of block.children) fsWalkMatch(child, depth + 1, out);
}

export function analyzeFirestore(source: string): AnalyzeResult {
  const out: AnalyzeResult = { ids: new Set(), unresolved: [] };
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) throw new Error(`firestore parse failed: ${parsed.error.message}`);
  const ast: FirestoreRules = parsed.ast;
  if (ast.version) out.ids.add('firestore.rule-kind.rules_version');
  if (ast.imports && ast.imports.length > 0) out.ids.add('firestore.rule-kind.import');
  fsWalkMatch(ast.service.match, 0, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════
// STORAGE
// ════════════════════════════════════════════════════════════════════

/** Structural view of the storage AST (its node types are module-private in
 *  src/storage/rules.ts; we walk `StorageRules._root` by shape). */
interface StExpr {
  kind: string;
  value?: unknown;
  name?: string;
  target?: StExpr;
  index?: StExpr;
  arg?: StExpr;
  op?: string;
  left?: StExpr;
  right?: StExpr;
  args?: StExpr[];
  method?: string;
  segments?: Array<{ kind: string; expr?: StExpr }>;
}
interface StMatch {
  segments: Array<{ kind: string }>;
  children: StMatch[];
  allows: Array<{ verbs: string[]; condition: StExpr | null }>;
  functions: Array<{ lets: Array<{ value: StExpr }>; body: StExpr }>;
}

const ST_BINOP: Record<string, string> = {
  '==': 'eq', '!=': 'neq', '<': 'lt', '>': 'gt', '<=': 'lte', '>=': 'gte',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '&&': 'and', '||': 'or',
};

let _stBindingIds: Set<string> | null = null;
function stBindingIds(): Set<string> {
  if (_stBindingIds) return _stBindingIds;
  _stBindingIds = new Set(loadSnapshot('storage').constructs.filter((c) => c.kind === 'binding').map((c) => c.id));
  return _stBindingIds;
}

function stDottedPath(e: StExpr): string | null {
  if (e.kind === 'ident') return e.name ?? null;
  if (e.kind === 'member' && e.target) {
    const base = stDottedPath(e.target);
    return base ? `${base}.${e.name}` : null;
  }
  return null;
}

function stWalkExpr(e: StExpr, out: AnalyzeResult): void {
  const add = (id: string) => out.ids.add(id);
  switch (e.kind) {
    case 'literal':
      return;
    case 'ident':
      if (e.name === 'request') add('storage.binding.request');
      else if (e.name === 'resource') add('storage.binding.resource');
      return;
    case 'member': {
      add('storage.operator.member');
      const path = stDottedPath(e);
      if (path) {
        const id = `storage.binding.${path}`;
        if (stBindingIds().has(id)) add(id);
        if (path.startsWith('request')) add('storage.binding.request');
        if (path.startsWith('resource')) add('storage.binding.resource');
      }
      if (e.target) stWalkExpr(e.target, out);
      return;
    }
    case 'index':
      add('storage.operator.index');
      if (e.target) stWalkExpr(e.target, out);
      if (e.index) stWalkExpr(e.index, out);
      return;
    case 'unary':
      add('storage.operator.not');
      if (e.arg) stWalkExpr(e.arg, out);
      return;
    case 'binary': {
      const op = e.op ? ST_BINOP[e.op] : undefined;
      if (op) add(`storage.operator.${op}`);
      if (e.left) stWalkExpr(e.left, out);
      if (e.right) stWalkExpr(e.right, out);
      return;
    }
    case 'call':
      // User-defined function call — not a language construct itself.
      for (const a of e.args ?? []) stWalkExpr(a, out);
      return;
    case 'methodcall': {
      const t = e.target;
      if (t && t.kind === 'ident' && t.name === 'timestamp') {
        add(`storage.function.timestamp.${e.method}`);
      } else if (t && t.kind === 'ident' && t.name === 'duration') {
        add(`storage.function.duration.${e.method}`);
      } else if (t && t.kind === 'ident' && t.name === 'firestore') {
        add(`storage.function.firestore.${e.method}`);
      } else if (e.method === 'matches') {
        add('storage.method.string.matches');
      } else {
        out.unresolved.push({ what: `method:${e.method}`, reason: 'storage: unrecognized method receiver' });
      }
      if (t) stWalkExpr(t, out);
      for (const a of e.args ?? []) stWalkExpr(a, out);
      return;
    }
    case 'path':
      for (const seg of e.segments ?? []) if (seg.expr) stWalkExpr(seg.expr, out);
      return;
  }
}

function stWalkMatch(block: StMatch, depth: number, out: AnalyzeResult): void {
  out.ids.add('storage.rule-kind.match');
  for (const seg of block.segments) {
    // `{name=**}` is the multi-segment recursive wildcard; `{name}` is a
    // single-segment path variable. BOTH bind a path variable — mirror the
    // Firestore analyzer, which credits path-variable for its wildcard and
    // recursive segments alike. (Previously only recursive-wildcard was
    // credited, leaving storage.binding.path-variable unreachable despite
    // every real storage ruleset binding at least `{bucket}`/`{fileId}`.)
    if (seg.kind === 'wildcard') out.ids.add('storage.semantic.recursive-wildcard');
    if (seg.kind === 'wildcard' || seg.kind === 'param') out.ids.add('storage.binding.path-variable');
  }
  for (const fn of block.functions) {
    out.ids.add('storage.rule-kind.function');
    if (fn.lets.length > 0) out.ids.add('storage.rule-kind.let');
    for (const l of fn.lets) stWalkExpr(l.value, out);
    stWalkExpr(fn.body, out);
  }
  for (const allow of block.allows) {
    for (const v of allow.verbs) {
      out.ids.add(`storage.rule-kind.allow-${v}`);
      if (v === 'read') out.ids.add('storage.semantic.read-umbrella');
      if (v === 'write') out.ids.add('storage.semantic.write-umbrella');
    }
    if (allow.condition) stWalkExpr(allow.condition, out);
  }
  for (const child of block.children) stWalkMatch(child, depth + 1, out);
}

export function analyzeStorage(source: string): AnalyzeResult {
  const out: AnalyzeResult = { ids: new Set(), unresolved: [] };
  // The storage parser accepts-and-DISCARDS the leading `rules_version`
  // declaration (it implements v2 semantics regardless), so the version is not
  // carried on the AST the way the Firestore parser exposes `ast.version`.
  // Detect the declaration from source so a real storage ruleset that declares
  // it is credited, mirroring analyzeFirestore's `if (ast.version)` branch.
  if (/(^|\n)\s*rules_version\s*=/.test(source)) out.ids.add('storage.rule-kind.rules_version');
  const rules = parseStorageRules(source) as unknown as { _root: StMatch };
  stWalkMatch(rules._root, 0, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════
// RTDB
// ════════════════════════════════════════════════════════════════════

const RTDB_BINDINGS = new Set(['auth', 'data', 'newData', 'root', 'now']);
const RTDB_SNAPSHOT_METHODS = new Set([
  'val', 'child', 'parent', 'hasChild', 'hasChildren', 'exists', 'getPriority', 'isNumber', 'isString', 'isBoolean',
]);
const RTDB_STRING_METHODS = new Set([
  'contains', 'beginsWith', 'endsWith', 'matches', 'replace', 'toLowerCase', 'toUpperCase',
]);
const RTDB_OP_CTOR: Record<string, string> = {
  Ternary_ternary: 'ternary',
  Logical_and: 'and', Logical_or: 'or',
  Comparison_strictEq: 'strictEq', Comparison_strictNeq: 'strictNeq',
  Comparison_gte: 'gte', Comparison_lte: 'lte', Comparison_gt: 'gt', Comparison_lt: 'lt',
  Comparison_looseEq: 'looseEq', Comparison_looseNeq: 'looseNeq',
  Additive_add: 'add', Additive_sub: 'sub',
  Multiplicative_mul: 'mul', Multiplicative_div: 'div', Multiplicative_mod: 'mod',
  UnaryExpr_not: 'not', UnaryExpr_neg: 'neg',
};

let _rtdbSemantics: ohm.Semantics | null = null;
/** A semantics operation over the EXISTING RTDB grammar that collects the
 *  construct ids an expression exercises. Reuses the parser's grammar (no new
 *  parsing); mirrors how `identifiers`/`validate` semantics are defined on the
 *  same grammar in database/grammar/. */
function rtdbSemantics(): ohm.Semantics {
  if (_rtdbSemantics) return _rtdbSemantics;
  const sem = rtdbGrammar.createSemantics();
  sem.addOperation<void>('collectInto(acc)', {
    _nonterminal(...children) {
      const op = RTDB_OP_CTOR[this.ctorName];
      if (op) (this.args as any).acc.ids.add(`rtdb.operator.${op}`);
      for (const c of children) (c as any).collectInto((this.args as any).acc);
    },
    _iter(...children) {
      for (const c of children) (c as any).collectInto((this.args as any).acc);
    },
    _terminal() {},
    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const acc = (this.args as any).acc as AnalyzeResult;
      const m = methodName.sourceString;
      if (RTDB_SNAPSHOT_METHODS.has(m)) acc.ids.add(`rtdb.method.snapshot.${m}`);
      else if (RTDB_STRING_METHODS.has(m)) acc.ids.add(`rtdb.method.string.${m}`);
      else acc.unresolved.push({ what: `method:${m}`, reason: 'rtdb: unknown method' });
      (receiver as any).collectInto(acc);
      for (const a of args.asIteration().children) (a as any).collectInto(acc);
    },
    CallExpr_memberAccess(receiver, _dot, memberName) {
      const acc = (this.args as any).acc as AnalyzeResult;
      acc.ids.add('rtdb.operator.member');
      const member = memberName.sourceString;
      const recvSrc = (receiver as any).sourceString as string;
      if (recvSrc === 'auth' && (member === 'uid' || member === 'token')) {
        acc.ids.add(`rtdb.binding.auth.${member}`);
      } else if (member === 'length') {
        acc.ids.add('rtdb.method.string.length');
      }
      (receiver as any).collectInto(acc);
    },
    CallExpr_indexAccess(receiver, _open, index, _close) {
      const acc = (this.args as any).acc as AnalyzeResult;
      acc.ids.add('rtdb.operator.index');
      (receiver as any).collectInto(acc);
      (index as any).collectInto(acc);
    },
    regex(_open, _body, _close, _flags) {
      const acc = (this.args as any).acc as AnalyzeResult;
      acc.ids.add('rtdb.semantic.regex-literal');
    },
    ident(dollar, _start, _rest) {
      const acc = (this.args as any).acc as AnalyzeResult;
      const name = this.sourceString;
      if (dollar.sourceString === '$') acc.ids.add('rtdb.binding.path-variable');
      else if (RTDB_BINDINGS.has(name)) acc.ids.add(`rtdb.binding.${name}`);
    },
  });
  _rtdbSemantics = sem;
  return sem;
}

function rtdbWalkExpr(raw: string, out: AnalyzeResult): void {
  const match = rtdbGrammar.match(raw.trim());
  if (match.failed()) {
    out.unresolved.push({ what: `expr`, reason: `rtdb expression failed to parse: ${raw}` });
    return;
  }
  (rtdbSemantics()(match) as any).collectInto(out);
}

function rtdbWalkTree(node: unknown, out: AnalyzeResult): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '.read') {
      out.ids.add('rtdb.rule-kind.read');
      if (typeof value === 'string') rtdbWalkExpr(value, out);
    } else if (key === '.write') {
      out.ids.add('rtdb.rule-kind.write');
      if (typeof value === 'string') rtdbWalkExpr(value, out);
    } else if (key === '.validate') {
      out.ids.add('rtdb.rule-kind.validate');
      if (typeof value === 'string') rtdbWalkExpr(value, out);
    } else if (key === '.indexOn') {
      out.ids.add('rtdb.rule-kind.indexOn');
    } else if (key.startsWith('$')) {
      out.ids.add('rtdb.rule-kind.location-wildcard');
      rtdbWalkTree(value, out);
    } else {
      rtdbWalkTree(value, out);
    }
  }
}

/** `rulesJson` is a JSON string of the rules subtree (matching the RTDB corpus
 *  `rules` field). Accepts either a bare subtree or a `{ "rules": {...} }`
 *  wrapper. */
export function analyzeRtdb(rulesJson: string): AnalyzeResult {
  const out: AnalyzeResult = { ids: new Set(), unresolved: [] };
  let tree: unknown;
  try {
    tree = JSON.parse(rulesJson);
  } catch (err) {
    throw new Error(`rtdb rules JSON parse failed: ${(err as Error).message}`);
  }
  if (tree && typeof tree === 'object' && 'rules' in (tree as Record<string, unknown>)) {
    tree = (tree as Record<string, unknown>).rules;
  }
  rtdbWalkTree(tree, out);
  return out;
}

/** Engine-dispatched entry point. */
export function analyze(engine: RulesEngine, source: string): AnalyzeResult {
  switch (engine) {
    case 'firestore':
      return analyzeFirestore(source);
    case 'storage':
      return analyzeStorage(source);
    case 'rtdb':
      return analyzeRtdb(source);
  }
}

// ════════════════════════════════════════════════════════════════════
// Computed coverage report (issue #185, step 2 exit criterion)
// ════════════════════════════════════════════════════════════════════

/** One scenario's shape, normalized across the three corpora. */
export interface Scenario {
  id: string;
  rules: string;
}

/** Load every corpus scenario for an engine plus its observation-twin ids. */
async function loadScenarios(
  engine: RulesEngine,
): Promise<{ scenarios: Scenario[]; twinIds: Set<string> }> {
  const { readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  // The rules capture runners write to the engine's NATIVE conformance surface
  // dir: rules twins land in `observations/<engine>-rules/`, not
  // `observations/<engine>/` (which holds the SDK-surface twins). This now holds
  // for all three engines — RTDB rules twins moved to `observations/rtdb-rules/`
  // when the rtdb-rules surface was admitted. Read from the same dir the runner
  // wrote to, or every twin is invisible and verified coverage reads 0.
  const OBS_SURFACE_DIR: Record<RulesEngine, string> = {
    firestore: 'firestore-rules',
    storage: 'storage-rules',
    rtdb: 'rtdb-rules',
  };
  const obsDir = join(here, '..', 'observations', OBS_SURFACE_DIR[engine]);
  let obsFiles: string[] = [];
  try {
    obsFiles = readdirSync(obsDir);
  } catch {
    obsFiles = [];
  }
  const prefix = `rules-${engine}-`;
  const twinIds = new Set(
    obsFiles
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => f.slice(prefix.length, -'.json'.length)),
  );

  let scenarios: Scenario[];
  if (engine === 'firestore') {
    const { ALL_RULES_FIRESTORE_SCENARIOS } = await import('../rules-corpus/firestore/index.ts');
    scenarios = ALL_RULES_FIRESTORE_SCENARIOS.map((p) => ({ id: p.id, rules: p.rules }));
  } else if (engine === 'storage') {
    const { ALL_RULES_STORAGE_SCENARIOS } = await import('../rules-corpus/storage/index.ts');
    scenarios = ALL_RULES_STORAGE_SCENARIOS.map((p) => ({ id: p.id, rules: p.rules }));
  } else {
    const { ALL_RULES_RTDB_SCENARIOS } = await import('../rules-corpus/rtdb/index.ts');
    scenarios = ALL_RULES_RTDB_SCENARIOS.map((p) => ({ id: p.id, rules: p.rules }));
  }
  return { scenarios, twinIds };
}

export interface ConstructCoverage {
  id: string;
  kind: string;
  /** All scenario ids that exercise the construct. */
  exercisedBy: string[];
  /** SYNTACTIC verification: the subset of `exercisedBy` whose observation twin
   *  exists, so production's verdict on that exact ruleset was captured and
   *  replayed. */
  verifiedBy: string[];
  /** BEHAVIORAL verification: the `conforms` + `oracle-backed` rules-engine
   *  registry rows whose `constructs` scope lists this construct — production
   *  verdicts that can only be explained by it. The path an engine semantic with
   *  no source token (the RTDB cascades) is credited by; see
   *  production-verification.ts. Either list, non-empty, verifies the construct. */
  verifiedByRows: string[];
  /** Mirrors the snapshot's `unattributable` (see rules-language/types.ts):
   *  present iff this construct can never be credited by static AST
   *  analysis. Such constructs are carried in `constructs` for the full
   *  audit trail but EXCLUDED from `totalConstructs` and the two coverage
   *  ratios below — counting a permanently-uncreditable construct in the
   *  denominator would put a ceiling on the trust number for a reason
   *  unrelated to real coverage gaps. An empty `exercisedBy`/`verifiedBy`
   *  here is expected forever, not a pending gap. */
  unattributable?: string;
}

export interface EngineCoverage {
  engine: RulesEngine;
  totalConstructs: number;
  exercisedConstructs: number;
  verifiedConstructs: number;
  /** exercised / total, 0..1 (analyzer-measured breadth over the corpus). */
  exercisedCoverage: number;
  /** verified / total, 0..1 — the trust number (production-confirmed). */
  verifiedCoverage: number;
  constructs: ConstructCoverage[];
  scenarioCount: number;
  verifiedScenarioCount: number;
  unresolved: Array<{ scenario: string; what: string; reason: string }>;
}

export interface CoverageReport {
  generatedNote: string;
  engines: EngineCoverage[];
}

const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'] as const;

export async function computeCoverageReport(): Promise<CoverageReport> {
  const engines: EngineCoverage[] = [];
  const { provingRows } = indexConstructScopes(surfaceRegistries);
  for (const engine of RULES_ENGINES) {
    const snapshot = loadSnapshot(engine);
    const { scenarios, twinIds } = await loadScenarios(engine);
    const cov = new Map<string, ConstructCoverage>();
    for (const c of snapshot.constructs) {
      cov.set(c.id, {
        id: c.id,
        kind: c.kind,
        exercisedBy: [],
        verifiedBy: [],
        verifiedByRows: provingRows.get(c.id) ?? [],
        ...(c.unattributable ? { unattributable: c.unattributable } : {}),
      });
    }
    const unresolved: EngineCoverage['unresolved'] = [];
    for (const scenario of scenarios) {
      const result = analyze(engine, scenario.rules);
      const verified = twinIds.has(scenario.id);
      for (const id of result.ids) {
        const entry = cov.get(id);
        if (!entry) {
          // Analyzer produced an id absent from the snapshot — a real bug we
          // want loud, not silently dropped.
          throw new Error(
            `analyzer emitted id "${id}" for ${engine} scenario "${scenario.id}" that is not in the snapshot`,
          );
        }
        entry.exercisedBy.push(scenario.id);
        if (verified) entry.verifiedBy.push(scenario.id);
      }
      for (const u of result.unresolved) unresolved.push({ scenario: scenario.id, ...u });
    }
    const constructs = [...cov.values()];
    // Permanently-unattributable constructs (see ConstructCoverage.unattributable)
    // are carried in `constructs` for the audit trail but excluded from the
    // denominator: they can never be credited by static AST analysis, so
    // counting them against the total would put an un-earnable ceiling on the
    // coverage ratios for a reason unrelated to real gaps.
    const attributable = constructs.filter((c) => !c.unattributable);
    const exercisedConstructs = attributable.filter((c) => c.exercisedBy.length > 0).length;
    // The SHARED predicate: syntactic (a captured scenario's AST contains it) OR
    // behavioral (a conforming, oracle-backed rules-engine row's scope lists it).
    const verifiedConstructs = attributable.filter((c) =>
      isProductionVerified({ scenarios: c.verifiedBy, provingRows: c.verifiedByRows }),
    ).length;
    const total = attributable.length;
    engines.push({
      engine,
      totalConstructs: total,
      exercisedConstructs,
      verifiedConstructs,
      exercisedCoverage: total ? exercisedConstructs / total : 0,
      verifiedCoverage: total ? verifiedConstructs / total : 0,
      constructs,
      scenarioCount: scenarios.length,
      verifiedScenarioCount: scenarios.filter((s) => twinIds.has(s.id)).length,
      unresolved,
    });
  }
  return {
    generatedNote:
      'Verified coverage = production-verified snapshot constructs / total ATTRIBUTABLE snapshot constructs. A construct is production-verified by either evidence path (the single predicate in src/production-verification.ts): SYNTACTIC — `verifiedBy` lists >=1 corpus scenario that exercises it and has an observation twin, so production\'s verdict on that exact ruleset was captured and replayed; or BEHAVIORAL — `verifiedByRows` lists >=1 `conforms` + `oracle-backed` rules-engine registry row whose `constructs` scope names it, meaning production verdicts that only that construct explains were captured and matched. The behavioral path exists because the analyzer reads SOURCE, and an engine semantic (the RTDB read/write cascades, `.validate` non-cascade) has no source token to read — only a verdict. A construct carrying `unattributable` (a pure meta-semantic that no single verdict positively demonstrates either: storage/rtdb deny-by-default, where nothing matched so nothing happened) is listed under its engine\'s `constructs` for the audit trail but excluded from totalConstructs/exercisedConstructs/verifiedConstructs and both ratios. Regenerated by rules-language-analyzer.ts.',
    engines,
  };
}

export async function writeCoverageReport(): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'rules-language', 'coverage-report.json');
  const report = await computeCoverageReport();
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return outPath;
}

if (import.meta.main) {
  const outPath = await writeCoverageReport();
  const report = await computeCoverageReport();
  for (const e of report.engines) {
    console.log(
      `${e.engine}: exercised ${e.exercisedConstructs}/${e.totalConstructs} ` +
        `(${(e.exercisedCoverage * 100).toFixed(1)}%), verified ${e.verifiedConstructs}/${e.totalConstructs} ` +
        `(${(e.verifiedCoverage * 100).toFixed(1)}%) over ${e.scenarioCount} scenarios ` +
        `(${e.verifiedScenarioCount} with twins); ${e.unresolved.length} unresolved refs`,
    );
  }
  console.log(`Wrote ${outPath}`);
}
