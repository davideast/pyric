import { parseStorageRules } from '../../pyric/src/storage/sandbox/rules.ts';
import type { AnalyzeResult } from './rules-language-analyzer.ts';
import { loadSnapshot } from '../rules-language/load.ts';

interface StExpr {
  kind: string;
  value?: unknown;
  name?: string;
  target?: StExpr;
  index?: StExpr;
  start?: StExpr;
  end?: StExpr;
  arg?: StExpr;
  op?: string;
  left?: StExpr;
  right?: StExpr;
  cond?: StExpr;
  then?: StExpr;
  else?: StExpr;
  element?: StExpr;
  collection?: StExpr;
  typeName?: string;
  elements?: StExpr[];
  entries?: Array<{ key: StExpr; value: StExpr }>;
  args?: StExpr[];
  method?: string;
  segments?: Array<{ kind: string; expr?: StExpr }>;
}
interface StMatch {
  segments: Array<{ kind: string }>;
  children: StMatch[];
  allows: Array<{ verbs: string[]; condition: StExpr | null }>;
  functions: Array<{ name: string; lets: Array<{ value: StExpr }>; body: StExpr }>;
}

const ST_NAMESPACES = new Set(['timestamp', 'duration', 'firestore', 'math', 'hashing', 'latlng']);
const ST_CASTS = new Set(['string', 'int', 'float', 'bool', 'path']);

const ST_BINOP: Record<string, string> = {
  '==': 'eq', '!=': 'neq', '<': 'lt', '>': 'gt', '<=': 'lte', '>=': 'gte',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
  '&&': 'and', '||': 'or',
};

const ST_SET_PRODUCING_METHODS = new Set([
  'toSet',
  'addedKeys',
  'removedKeys',
  'changedKeys',
  'unchangedKeys',
  'affectedKeys',
  'difference',
  'intersection',
  'union',
]);

const ST_UNIQUE_METHODS: Record<string, string> = {
  size: 'storage.method.size',
  matches: 'storage.method.string.matches',
  split: 'storage.method.string.split',
  lower: 'storage.method.string.lower',
  upper: 'storage.method.string.upper',
  trim: 'storage.method.string.trim',
  replace: 'storage.method.string.replace',
  toUtf8: 'storage.method.string.toUtf8',
  toBase64: 'storage.method.bytes.toBase64',
  toHexString: 'storage.method.bytes.toHexString',
  date: 'storage.method.timestamp.date',
  year: 'storage.method.timestamp.year',
  month: 'storage.method.timestamp.month',
  day: 'storage.method.timestamp.day',
  hours: 'storage.method.timestamp.hours',
  minutes: 'storage.method.timestamp.minutes',
  dayOfWeek: 'storage.method.timestamp.dayOfWeek',
  dayOfYear: 'storage.method.timestamp.dayOfYear',
  time: 'storage.method.timestamp.time',
  toMillis: 'storage.method.timestamp.toMillis',
  keys: 'storage.method.map.keys',
  values: 'storage.method.map.values',
  get: 'storage.method.map.get',
  diff: 'storage.method.map.diff',
  addedKeys: 'storage.method.mapdiff.addedKeys',
  removedKeys: 'storage.method.mapdiff.removedKeys',
  changedKeys: 'storage.method.mapdiff.changedKeys',
  unchangedKeys: 'storage.method.mapdiff.unchangedKeys',
  affectedKeys: 'storage.method.mapdiff.affectedKeys',
  hasAll: 'storage.method.set.hasAll',
  difference: 'storage.method.set.difference',
  intersection: 'storage.method.set.intersection',
  union: 'storage.method.set.union',
  toSet: 'storage.method.list.toSet',
  join: 'storage.method.list.join',
  concat: 'storage.method.list.concat',
  removeAll: 'storage.method.list.removeAll',
  latitude: 'storage.method.latlng.latitude',
  longitude: 'storage.method.latlng.longitude',
  distance: 'storage.method.latlng.distance',
  bind: 'storage.method.path.bind',
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

function stInferTimeOrSetType(e: StExpr | undefined): 'timestamp' | 'duration' | 'set' | null {
  if (!e) return null;
  if (e.kind === 'member') {
    const path = stDottedPath(e);
    if (
      path === 'request.time' ||
      path === 'resource.timeCreated' ||
      path === 'resource.updated' ||
      path === 'request.resource.timeCreated' ||
      path === 'request.resource.updated'
    ) {
      return 'timestamp';
    }
    return null;
  }
  if (e.kind === 'methodcall') {
    if (e.target?.kind === 'ident') {
      if (e.target.name === 'timestamp' && (e.method === 'date' || e.method === 'value')) return 'timestamp';
      if (e.target.name === 'duration' && (e.method === 'value' || e.method === 'time' || e.method === 'abs')) {
        return 'duration';
      }
    }
    if (e.method === 'date') return 'timestamp';
    if (e.method === 'time') return 'duration';
    if (e.method && ST_SET_PRODUCING_METHODS.has(e.method)) return 'set';
    return null;
  }
  if (e.kind === 'binary' && (e.op === '+' || e.op === '-')) {
    const lt = stInferTimeOrSetType(e.left);
    const rt = stInferTimeOrSetType(e.right);
    if (e.op === '-') {
      if (lt === 'timestamp' && rt === 'timestamp') return 'duration';
      if (lt === 'timestamp' && rt === 'duration') return 'timestamp';
      if (lt === 'duration' && rt === 'duration') return 'duration';
      return null;
    }
    if (lt === 'timestamp' && rt === 'duration') return 'timestamp';
    if (lt === 'duration' && rt === 'timestamp') return 'timestamp';
    if (lt === 'duration' && rt === 'duration') return 'duration';
    return null;
  }
  if (e.kind === 'ternary') {
    return stInferTimeOrSetType(e.then) ?? stInferTimeOrSetType(e.else);
  }
  return null;
}

function stAttributeMethod(e: StExpr, out: AnalyzeResult): void {
  const method = e.method ?? '';
  if (method === 'seconds' || method === 'nanos') {
    const recv = stInferTimeOrSetType(e.target);
    if (recv === 'timestamp' || recv === 'duration') {
      out.ids.add(`storage.method.${recv}.${method}`);
      return;
    }
    out.unresolved.push({
      what: `method:${method}`,
      reason: `receiver type unknown; name ambiguous across timestamp/duration`,
    });
    return;
  }
  if (method === 'hasAny' || method === 'hasOnly') {
    const recv = stInferTimeOrSetType(e.target);
    if (recv === 'set') {
      out.ids.add(`storage.method.set.${method}`);
    } else {
      out.ids.add(`storage.method.list.${method}`);
    }
    return;
  }
  const unique = ST_UNIQUE_METHODS[method];
  if (unique) {
    out.ids.add(unique);
    return;
  }
  out.unresolved.push({ what: `method:${method}`, reason: 'storage: unrecognized method receiver' });
}

function stWalkExpr(e: StExpr, fnNames: ReadonlySet<string>, out: AnalyzeResult): void {
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
      if (e.target) stWalkExpr(e.target, fnNames, out);
      return;
    }
    case 'index':
      add('storage.operator.index');
      if (e.target) stWalkExpr(e.target, fnNames, out);
      if (e.index) stWalkExpr(e.index, fnNames, out);
      return;
    case 'slice':
      add('storage.operator.slice');
      if (e.target) stWalkExpr(e.target, fnNames, out);
      if (e.start) stWalkExpr(e.start, fnNames, out);
      if (e.end) stWalkExpr(e.end, fnNames, out);
      return;
    case 'unary':
      if (e.op === '-') add('storage.operator.unary-minus');
      else add('storage.operator.not');
      if (e.arg) stWalkExpr(e.arg, fnNames, out);
      return;
    case 'binary': {
      const op = e.op ? ST_BINOP[e.op] : undefined;
      if (op) add(`storage.operator.${op}`);
      if (e.left) stWalkExpr(e.left, fnNames, out);
      if (e.right) stWalkExpr(e.right, fnNames, out);
      return;
    }
    case 'ternary':
      add('storage.operator.ternary');
      if (e.cond) stWalkExpr(e.cond, fnNames, out);
      if (e.then) stWalkExpr(e.then, fnNames, out);
      if (e.else) stWalkExpr(e.else, fnNames, out);
      return;
    case 'in':
      add('storage.operator.in');
      if (e.element) stWalkExpr(e.element, fnNames, out);
      if (e.collection) stWalkExpr(e.collection, fnNames, out);
      return;
    case 'is':
      add('storage.operator.is');
      if (e.value && typeof e.value === 'object') stWalkExpr(e.value as StExpr, fnNames, out);
      return;
    case 'list':
      for (const el of e.elements ?? []) stWalkExpr(el, fnNames, out);
      return;
    case 'map':
      for (const entry of e.entries ?? []) {
        stWalkExpr(entry.key, fnNames, out);
        stWalkExpr(entry.value, fnNames, out);
      }
      return;
    case 'call':
      if (e.name && !fnNames.has(e.name) && ST_CASTS.has(e.name)) {
        add(`storage.function.cast.${e.name}`);
      }
      for (const a of e.args ?? []) stWalkExpr(a, fnNames, out);
      return;
    case 'methodcall': {
      const t = e.target;
      if (t && t.kind === 'ident' && t.name && ST_NAMESPACES.has(t.name)) {
        add(`storage.function.${t.name}.${e.method}`);
      } else {
        stAttributeMethod(e, out);
      }
      if (t) stWalkExpr(t, fnNames, out);
      for (const a of e.args ?? []) stWalkExpr(a, fnNames, out);
      return;
    }
    case 'path':
      for (const seg of e.segments ?? []) if (seg.expr) stWalkExpr(seg.expr, fnNames, out);
      return;
  }
}

function stWalkMatch(block: StMatch, depth: number, outerFnNames: ReadonlySet<string>, out: AnalyzeResult): void {
  out.ids.add('storage.rule-kind.match');
  const fnNames = new Set(outerFnNames);
  for (const fn of block.functions) {
    if (fn.name) fnNames.add(fn.name);
  }
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
    for (const l of fn.lets) stWalkExpr(l.value, fnNames, out);
    stWalkExpr(fn.body, fnNames, out);
  }
  for (const allow of block.allows) {
    for (const v of allow.verbs) {
      out.ids.add(`storage.rule-kind.allow-${v}`);
      if (v === 'read') out.ids.add('storage.semantic.read-umbrella');
      if (v === 'write') out.ids.add('storage.semantic.write-umbrella');
    }
    if (allow.condition) stWalkExpr(allow.condition, fnNames, out);
  }
  for (const child of block.children) stWalkMatch(child, depth + 1, fnNames, out);
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
  stWalkMatch(rules._root, 0, new Set(), out);
  return out;
}
