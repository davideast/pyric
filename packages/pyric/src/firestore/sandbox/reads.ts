/**
 * Reads / query execution — list-query shape helpers for the Firestore
 * sandbox engine (ADR-0007 mechanical extraction from
 * `local-environment.ts`).
 */
import type { ListQuery } from 'pyric/rules/internal';
import type { QueryConstraints } from './list-query-proof.js';

export function listQueryFromStructured(structured: QueryConstraints): ListQuery | undefined {
  if (structured.limit == null && structured.offset == null && structured.orderBy == null) {
    return undefined;
  }
  return {
    ...(structured.limit != null ? { limit: structured.limit } : {}),
    ...(structured.offset != null ? { offset: structured.offset } : {}),
    ...(structured.orderBy != null ? { orderBy: structured.orderBy } : {}),
  };
}
