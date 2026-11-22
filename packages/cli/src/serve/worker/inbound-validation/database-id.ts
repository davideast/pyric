/**
 * Untrusted wire validation for Firestore `databaseId` fields (ADR-0021 Decision 4).
 *
 * When present on a Firestore op or listener subscription, `databaseId` must be
 * a non-empty string of at most 256 characters. Naming-rule validation happens
 * only on declaring paths (`setRules`), while undeclared ids within the 256-char
 * wire bound resolve as missing databases (Decision 3).
 */
import { requireShape } from './fields.js';

const MAX_WIRE_DATABASE_ID_LENGTH = 256;

const FIRESTORE_OP_METHODS_WITH_DATABASE_ID = new Set<string>([
  'getDoc',
  'getDocs',
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'addDoc',
  'count',
  'aggregate',
  'batchCommit',
  'txnCommit',
  'listRootCollections',
  'listSubcollections',
  'setRules',
  'setFirestoreRules',
  'getActiveRules',
  'getRulesStatus',
  'admin.getDocument',
  'admin.listDocuments',
  'admin.setDocument',
  'admin.deleteDocument',
  'admin.readState',
]);

function assertBoundedDatabaseId(value: unknown, field: string): void {
  if (value === undefined) return;
  const valid =
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WIRE_DATABASE_ID_LENGTH;
  requireShape(valid, field);
}

export function assertFirestoreOpDatabaseId(message: Record<string, unknown>): void {
  const method = message.method;
  if (typeof method !== 'string') return;
  if (!FIRESTORE_OP_METHODS_WITH_DATABASE_ID.has(method)) {
    requireShape(message.databaseId === undefined, 'databaseId');
    return;
  }
  if (
    (method === 'getActiveRules' || method === 'getRulesStatus') &&
    message.service === 'database'
  ) {
    requireShape(message.databaseId === undefined, 'databaseId');
    return;
  }
  assertBoundedDatabaseId(message.databaseId, 'databaseId');
}

export function assertFirestoreSubDatabaseId(
  message: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  assertBoundedDatabaseId(message.databaseId, 'databaseId');
  assertBoundedDatabaseId(target.databaseId, 'target.databaseId');
  if (message.databaseId !== undefined && target.databaseId !== undefined) {
    requireShape(message.databaseId === target.databaseId, 'target.databaseId');
  }
}
