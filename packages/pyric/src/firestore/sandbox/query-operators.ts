import { FirestoreCompatError } from './firestore-compat-error.js';

export const QUERY_WHERE_OPERATORS = [
  '<', '<=', '==', '!=', '>=', '>', 'in', 'not-in', 'array-contains', 'array-contains-any',
] as const;
export type QueryWhereFilterOp = typeof QUERY_WHERE_OPERATORS[number];

const whereOperators = new Set<unknown>(QUERY_WHERE_OPERATORS);

export function assertQueryWhereOperator(operator: unknown): void {
  const hasUnsupportedOperator = !whereOperators.has(operator);
  if (hasUnsupportedOperator) {
    throw new FirestoreCompatError({ code: 'invalid-argument', message: 'Unsupported Firestore filter operator.' });
  }
}
