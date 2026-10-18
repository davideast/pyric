/**
 * Reads / query execution — list-query shape helpers for the Firestore
 * sandbox engine (ADR-0007 mechanical extraction from
 * `local-environment.ts`).
 */
import type { ListQuery } from 'pyric/rules/internal';
import { listQueryFromConstraints, type QueryConstraints } from './list-query-proof.js';

export function listQueryFromStructured(structured: QueryConstraints): ListQuery | undefined {
  return listQueryFromConstraints(structured);
}
