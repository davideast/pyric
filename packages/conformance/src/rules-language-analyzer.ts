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
 * issue is built to protect.
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
      return FS_METHOD_RETURNS[e.method] ?? null;
    case 'functionCall':
      if (e.name === 'get' || e.name === 'getAfter') return 'map';
      if (FS_CASTS.has(e.name)) return e.name === 'int' || e.name === 'float' ? 'number' : e.name;
      return null;
    case 'ternary':
      return fsInferType(e.consequent) ?? fsInferType(e.alternate);
    default:
      return null;
  }
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
  for (const seg of block.segments) if (seg.kind === 'wildcard') out.ids.add('storage.semantic.recursive-wildcard');
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
  // dir (issue #184): Firestore/Storage rules twins land in
  // `observations/<engine>-rules/`, not `observations/<engine>/` (which holds the
  // SDK-surface twins). RTDB rules ride the plain `rtdb` surface (its runner
  // writes there and has no Test API twins). Read from the same dir the runner
  // wrote to, or every twin is invisible and verified coverage reads 0.
  const OBS_SURFACE_DIR: Record<RulesEngine, string> = {
    firestore: 'firestore-rules',
    storage: 'storage-rules',
    rtdb: 'rtdb',
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
  /** The subset whose observation twin exists (production-verified). */
  verifiedBy: string[];
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
  for (const engine of RULES_ENGINES) {
    const snapshot = loadSnapshot(engine);
    const { scenarios, twinIds } = await loadScenarios(engine);
    const cov = new Map<string, ConstructCoverage>();
    for (const c of snapshot.constructs) {
      cov.set(c.id, { id: c.id, kind: c.kind, exercisedBy: [], verifiedBy: [] });
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
    const exercisedConstructs = constructs.filter((c) => c.exercisedBy.length > 0).length;
    const verifiedConstructs = constructs.filter((c) => c.verifiedBy.length > 0).length;
    const total = constructs.length;
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
      'DRAFT (issue #185 step 2). Verified coverage = snapshot constructs exercised by >=1 corpus scenario that has an observation twin / total snapshot constructs. Regenerated by rules-language-analyzer.ts. Not yet wired into the ratchet (step 4).',
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
