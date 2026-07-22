import { parseToASTOrError } from '../../pyric/src/rules/grammar/FirestoreParser.ts';
import type { Expression, FirestoreRules, MatchBlock } from '../../pyric/src/rules/grammar/FirestoreAST.ts';
import type { AnalyzeResult } from './rules-language-analyzer.ts';
import { loadSnapshot } from '../rules-language/load.ts';

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
  keys: 'list', values: 'list', diff: 'mapdiff',
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
  // A unique method name cannot override a known, incompatible receiver.
  // The fallback exists only for genuinely unknown receiver types.
  if (!recv && candidates && candidates.length === 1) {
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
