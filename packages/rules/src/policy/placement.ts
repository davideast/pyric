import type { Expression, MatchBlock, Operation } from '../grammar/FirestoreAST.js';
import { exprContains } from '../grammar/function-scopes.js';
import { assembleRules } from '../grammar/FirestoreAssembler.js';
import { parseToASTOrError, firestoreGrammar, firestoreSemantics } from '../grammar/FirestoreParser.js';
import { parseRtdbExpressionTree } from '../rtdb/grammar/expression-tree.js';
import type { FirestoreBindings } from './firestore.js';
import { hasRequiredConjunct, type RtdbBindings } from './rtdb.js';

interface RequirementRow { requirement: string; reason: string; predicate?: string; completeReason?: string }
export interface FirestorePlacement {
  path: string;
  operation: 'create' | 'update' | 'delete';
  bindings: FirestoreBindings;
}
export interface FirestoreTemplate {
  rules: string;
  slot: string;
  placements: readonly FirestorePlacement[];
}

function slotCall(node: Expression, slot: string) {
  return node.type === 'functionCall' && node.name === slot && node.args.length === 0;
}

// The placement must be a direct condition of the grant. A call behind a
// disjunction, negation or helper cannot establish that the policy is required.
function replaceConjunct(expr: Expression, slot: string, replacement: Expression): Expression {
  if (slotCall(expr, slot)) return replacement;
  if (expr.type !== 'binaryOp' || expr.op !== '&&') return expr;
  return { ...expr, left: replaceConjunct(expr.left, slot, replacement), right: replaceConjunct(expr.right, slot, replacement) };
}

function countSlots(expr: Expression, slot: string): number {
  if (slotCall(expr, slot)) return 1;
  if (expr.type === 'binaryOp' && expr.op === '&&') return countSlots(expr.left, slot) + countSlots(expr.right, slot);
  if (exprContains(expr, node => node.type === 'functionCall' && node.name === slot))
    throw new Error(slot + ' must be a zero-argument call in a required conjunct');
  return 0;
}
function covers(operations: Operation[], operation: Operation) {
  return operations.includes(operation) || operations.includes('write');
}

export function composeFirestore<R extends RequirementRow>(
  template: FirestoreTemplate, names: string[], lower: (bindings: FirestoreBindings) => R[],
) {
  const parsed = parseToASTOrError(template.rules);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const ast = parsed.ast, root = ast.service.match;
  if (ast.service.name !== 'cloud.firestore' || (ast.services?.length ?? 1) !== 1 ||
      (ast.service.matches?.length ?? 1) !== 1 || ast.imports.length || ast.functions?.length || ast.service.functions?.length)
    throw new Error('Expected one standalone Firestore service and database root');
  const declarations = root.functions.filter(fn => fn.name === template.slot);
  const slot = declarations[0];
  if (declarations.length !== 1 || slot.parameters.length || slot.lets.length ||
      slot.body.type !== 'literal' || slot.body.value !== false)
    throw new Error('Expected a zero-argument database-root slot returning false: ' + template.slot);

  const pending = new Map<string, FirestorePlacement>();
  const diagnostics: string[] = [];
  const report: { path: string; operation: Operation; requirements: R[] }[] = [];
  for (const placement of template.placements) {
    const key = placement.operation + ' ' + placement.path;
    if (pending.has(key)) throw new Error('Duplicate placement: ' + key);
    pending.set(key, placement);
  }
  function visit(block: MatchBlock, path: string) {
    if (block !== root && block.functions.some(fn => fn.name === template.slot))
      throw new Error('Shadowed policy slot at ' + path);
    for (const fn of block.functions) {
      if ([fn.body, ...fn.lets.map(binding => binding.value)].some(expr =>
        exprContains(expr, node => node.type === 'functionCall' && node.name === template.slot)))
        throw new Error('Policy slot inside helper ' + fn.name + ' at ' + path);
    }
    for (const allow of block.allows) {
      const count = countSlots(allow.condition, template.slot);
      if (count === 0) continue;
      if (count > 1) throw new Error('Repeated policy slot at ' + path);
      const operation = allow.operations[0];
      if (allow.operations.length !== 1 || !['create', 'update', 'delete'].includes(operation))
        throw new Error('A policy slot needs a single write operation at ' + path);
      const key = operation + ' ' + path;
      if (block.allows.some(other => other !== allow && covers(other.operations, operation)))
        throw new Error('Another allow covers ' + key);
      const placement = pending.get(key);
      if (!placement) {
        diagnostics.push('Missing placement ' + key + ': ' + names.join(', '));
        continue;
      }
      pending.delete(key);
      const requirements = lower(placement.bindings);
      const residual = requirements.filter(row => !row.predicate || row.completeReason);
      if (residual.length) {
        diagnostics.push(...residual.map(row => key + ' ' + row.requirement + ': ' + (row.completeReason ?? row.reason)));
        continue;
      }
      const predicates = requirements.map(row => {
        const match = firestoreGrammar.match(row.predicate!, 'Expr');
        if (match.failed()) throw new Error(match.message);
        return firestoreSemantics(match).toAST() as Expression;
      });
      const condition = predicates.reduce((left, right) => ({ type: 'binaryOp', op: '&&', left, right }));
      allow.condition = replaceConjunct(allow.condition, template.slot, condition);
      report.push({ path, operation, requirements });
    }
    for (const child of block.children) visit(child, path + child.path.raw);
  }
  visit(root, root.path.raw);
  for (const key of pending.keys()) diagnostics.push('Missing conjunctive policy slot for ' + key + ': ' + names.join(', '));
  if (!report.length && !diagnostics.length) diagnostics.push('No policy placements: ' + names.join(', '));
  if (diagnostics.length) throw new Error(diagnostics.join('\n'));
  return { rules: assembleRules(ast), placements: report };
}

export interface RealtimePlacement {
  path: string;
  bindings: RtdbBindings;
  mode?: 'complete' | 'mixed';
}

export function bindRealtime<R extends RequirementRow>(placement: RealtimePlacement, requirements: R[]) {
  const parts = placement.path.split('/').slice(1);
  if (!placement.path.startsWith('/') || !parts.length || parts.some(p => !p || /[.#\[\]]/.test(p)))
    throw new Error('Expected an absolute RTDB validation path');
  const residuals = requirements.filter(row => !row.predicate || row.completeReason);
  if (placement.mode !== 'mixed' && residuals.length)
    throw new Error(residuals.map(row => row.requirement + ': ' + (row.completeReason ?? row.reason)).join('\n'));
  return {
    path: placement.path, operation: '.validate', requirements,
    verify(rules: { rules: unknown }) {
      let node: unknown = rules.rules;
      for (const key of [...parts, '.validate']) {
        node = node && typeof node === 'object' && Object.hasOwn(node, key)
          ? (node as Record<string, unknown>)[key] : undefined;
      }
      const actual = typeof node === 'string' && parseRtdbExpressionTree(node);
      for (const row of requirements) {
        if (!row.predicate) continue;
        const expected = parseRtdbExpressionTree(row.predicate);
        if (!actual || !actual.ok || !expected.ok || !hasRequiredConjunct(actual.tree, JSON.stringify(expected.tree)))
          throw new Error('Missing .validate placement at ' + placement.path + ' for ' + row.requirement);
      }
    },
  };
}
