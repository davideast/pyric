import { FirestoreCompatError } from './firestore-compat-error.js';

export const QUERY_WHERE_OPERATORS = [
  '<', '<=', '==', '!=', '>=', '>', 'in', 'not-in', 'array-contains', 'array-contains-any',
] as const;
export type QueryWhereFilterOp = typeof QUERY_WHERE_OPERATORS[number];

const whereOperators = new Set<unknown>(QUERY_WHERE_OPERATORS);

export function assertQueryWhereFilter(operator: unknown, value: unknown): void {
  const hasUnsupportedOperator = !whereOperators.has(operator);
  if (hasUnsupportedOperator) {
    throw new FirestoreCompatError({ code: 'invalid-argument', message: 'Unsupported Firestore filter operator.' });
  }
  const requiresArrayOperand = operator === 'in' || operator === 'not-in' || operator === 'array-contains-any';
  const hasInvalidOperand = requiresArrayOperand && !Array.isArray(value);
  if (hasInvalidOperand) {
    throw new FirestoreCompatError({ code: 'invalid-argument', message: `Firestore ${operator} filter requires an array operand.` });
  }
}
