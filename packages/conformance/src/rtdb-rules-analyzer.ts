import * as ohm from 'ohm-js';
import { createRtdbExpressionSemantics, matchRtdbExpression } from '../../pyric/src/rules/rtdb/expression-engine.ts';
import type { AnalyzeResult } from './rules-language-analyzer.ts';

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
/** A semantics operation over the shared RTDB expression engine that collects
 *  the construct ids an expression exercises. */
function rtdbSemantics(): ohm.Semantics {
  if (_rtdbSemantics) return _rtdbSemantics;
  const sem = createRtdbExpressionSemantics();
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
  const match = matchRtdbExpression(raw);
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
