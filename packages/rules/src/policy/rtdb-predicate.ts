// Opt-in RTDB numeric target. Bindings name snapshots, never raw rule source.
// Numeric leaves and arithmetic use RTDB numbers. Division, collections,
// strings, function calls and unbounded expansion have no lowering here.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { field } from './firestore.js';

export interface NumericSnapshot {
  snapshot: 'data' | 'newData';
  parent?: boolean;
  path?: string;
}
type Term = { text: string; kind: 'number' | 'boolean' };
const key = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emitRtdbNumericPredicate(fn: FunctionDef, bindings: Record<string, NumericSnapshot>): string {
  const guard = new Set<string>();
  const locals = new Map<string, Term>();
  if (Object.keys(bindings).length !== fn.parameters.length ||
      fn.parameters.some(name => !Object.hasOwn(bindings, name))) throw new Error('RTDB parameter bindings must match');
  for (const binding of Object.values(bindings)) {
    if (!binding || !['data','newData'].includes(binding.snapshot) ||
        (binding.parent !== undefined && typeof binding.parent !== 'boolean') ||
        (binding.path !== undefined && (typeof binding.path !== 'string' || !binding.path.split('/').every(p => key.test(p))))) {
      throw new Error('Invalid RTDB snapshot binding');
    }
  }
  function term(text: string, kind: Term['kind']): Term {
    if (text.length > 16384) throw new Error('RTDB predicate exceeds emission limit');
    return {text, kind};
  }
  function emit(expr: Expression): Term {
    const path = field(expr);
    if (path) {
      const local = locals.get(path);
      if (local) return local;
      const [name, ...keys] = path.split('.');
      if (!Object.hasOwn(bindings, name!) || !keys.every(k => key.test(k))) throw new Error('Unsupported RTDB field ' + path);
      const binding = bindings[name!]!;
      const child = [binding.path, ...keys].filter(Boolean).join('/');
      const node = binding.snapshot + (binding.parent ? '.parent()' : '') + (child ? '.child(' + JSON.stringify(child) + ')' : '');
      guard.add(node + '.isNumber()');
      return term(node + '.val()', 'number');
    }
    if (expr.type === 'literal') {
      if (typeof expr.value === 'boolean') return term(String(expr.value), 'boolean');
      if (typeof expr.value === 'number' && Number.isFinite(expr.value) && Math.abs(expr.value) <= Number.MAX_SAFE_INTEGER) return term(String(expr.value), 'number');
    }
    if (expr.type === 'binaryOp') {
      const left = emit(expr.left), right = emit(expr.right);
      const arithmetic = ['+', '-', '*'].includes(expr.op);
      const compare = ['<', '<=', '>', '>='].includes(expr.op);
      const logical = ['&&', '||'].includes(expr.op);
      const equal = ['==', '!='].includes(expr.op);
      if (left.kind === right.kind && ((left.kind === 'number' && (arithmetic || compare)) ||
          (left.kind === 'boolean' && logical) || equal)) {
        return term('(' + left.text + ' ' + expr.op + ' ' + right.text + ')', arithmetic ? 'number' : 'boolean');
      }
    }
    if (expr.type === 'ternary') {
      const cond = emit(expr.condition), yes = emit(expr.consequent), no = emit(expr.alternate);
      if (cond.kind === 'boolean' && yes.kind === no.kind) return term('(' + cond.text + ' ? ' + yes.text + ' : ' + no.text + ')', yes.kind);
    }
    throw new Error('Unsupported RTDB numeric expression: ' + expr.type);
  }
  for (const binding of fn.lets) locals.set(binding.name, emit(binding.value));
  const result = emit(fn.body);
  if (result.kind !== 'boolean') throw new Error('RTDB validation requires a boolean result');
  return term([...guard, result.text].join(' && '), 'boolean').text;
}
