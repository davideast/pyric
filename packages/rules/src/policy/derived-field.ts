import type { Expression } from '../grammar/FirestoreAST.js';
import { expressionChildren } from '../grammar/call-depth-limits.js';
import { substituteIdentifiers } from '../simulator/query-proof-scope.js';
import { field } from './firestore.js';
import { collectBoundedOps, isPureRulesExpr, type IRDerivation } from './ir.js';

// Local declarations have already passed the no-shadowing and no-forward-read
// checks. Substitution shares earlier expression nodes, so this map is linear
// in the size of the source even for "let next = prev + prev" chains.
export function bindDerivedLocals(derivation: IRDerivation) {
  const locals = new Map<string, Expression>();
  const operations = new Map<string, string>();
  for (const binding of derivation.lets) {
    if (binding.value.type === 'boundedOp') {
      operations.set(binding.name, 'bounded.' + binding.value.op);
    } else if (!isPureRulesExpr(binding.value)) {
      const ops = collectBoundedOps(binding.value);
      operations.set(binding.name, 'bounded.' + (ops[0] ?? 'op'));
    } else {
      locals.set(binding.name, substituteIdentifiers(binding.value, locals));
    }
  }
  return { locals, operations };
}

// Track the actual output(s) a requirement reads, including through ordinary
// aliases. Visit shared subtrees once; a short alias chain can expand exponentially.
export function derivedCollectionReads(
  outputs: Expression,
  reads: ReadonlySet<string>,
  { locals, operations }: ReturnType<typeof bindDerivedLocals>,
): string[] {
  if (operations.size === 0 || outputs.type !== 'mapLiteral') return [];
  if (reads.has('derived')) return [...operations.keys()];
  const keys = new Set([...reads].filter((p) => p.startsWith('derived.')).map((p) => p.split('.')[1]));
  const seen = new Set<Expression>();
  const dependencies = new Set<string>();
  function collect(node: Expression) {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === 'identifier' && operations.has(node.name)) dependencies.add(node.name);
    for (const child of expressionChildren(node)) collect(child);
  }
  for (const { key, value } of outputs.entries) {
    if (key.type !== 'literal' || typeof key.value !== 'string') return [...operations.keys()];
    if (keys.has(key.value)) collect(substituteIdentifiers(value, locals));
  }
  return [...dependencies];
}

function withinProjectionBudget(expr: Expression) {
  let remaining = 200;
  function fits(node: Expression, depth: number): boolean {
    if (--remaining < 0 || depth > 40) return false;
    return expressionChildren(node).every((child) => fits(child, depth + 1));
  }
  return fits(expr, 0);
}

interface SelectedField {
  key: string;
  expanded?: Expression;
}

export function projectDerivedField(
  condition: Expression,
  outputs: Expression,
  locals: ReadonlyMap<string, Expression>,
): SelectedField | string {
  if (condition.type !== 'binaryOp' || condition.op !== '==') {
    return 'Requires derive: expected a direct equality with a submitted field';
  }
  const left = field(condition.left);
  const right = field(condition.right);
  const selected = left?.startsWith('after.') ? right : right?.startsWith('after.') ? left : undefined;
  if (!selected || !/^derived\.[^.]+$/.test(selected)) {
    return 'Requires derive: expected a direct equality with a submitted field';
  }
  const key = selected.slice('derived.'.length);
  if (outputs.type !== 'mapLiteral') return 'Requires a returned map literal';
  let output: Expression | undefined;
  const keys = new Set<string>();
  for (const entry of outputs.entries) {
    if (entry.key.type !== 'literal' || typeof entry.key.value !== 'string' || keys.has(entry.key.value)) {
      return 'Requires unique, literal derive output keys';
    }
    keys.add(entry.key.value);
    if (key === entry.key.value) output = entry.value;
  }
  if (!output) return 'Unknown derive output: ' + key;
  const value = substituteIdentifiers(output, locals);
  const expanded = {
    ...condition,
    left: left === selected ? value : condition.left,
    right: right === selected ? value : condition.right,
  };
  // Inlining consumes no function calls or let slots. Count shared subtrees on
  // every use before the emitter can turn a compact DAG into exponential text.
  return { key, expanded: withinProjectionBudget(expanded) ? expanded : undefined };
}
