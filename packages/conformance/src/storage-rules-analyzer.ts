import { parseStorageRules } from '../../pyric/src/storage/rules.ts';
import type { AnalyzeResult } from './rules-language-analyzer.ts';
import { loadSnapshot } from '../rules-language/load.ts';

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
