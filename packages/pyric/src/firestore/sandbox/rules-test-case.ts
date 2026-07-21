import type { DocStore, DocumentData } from './local-state.js';
import type { Operation } from './writes.js';
import { partitionDeletes } from './value-resolver.js';
import type { TestCase, Timestamp } from 'pyric/rules/internal';
import { isoFromTimestamp } from './rules-evaluation.js';

/** Build the byte-identical rules test case shared by read and write engines. */
export function buildRulesTestCase(
  state: DocStore,
  operation: Operation,
  serverTime?: Timestamp,
): TestCase {
  const existingDoc = state.get(operation.path);
  const ruleMethod: TestCase['method'] = operation.method === 'set'
    ? (existingDoc !== null ? 'update' : 'create')
    : (operation.method as TestCase['method']);

  let requestData = operation.data;
  if (operation.method === 'get' || operation.method === 'list') {
    requestData = undefined;
  } else if (operation.method === 'update' && existingDoc && operation.data) {
    const { writes, deletedKeys } = partitionDeletes(operation.data);
    const merged: DocumentData = { ...existingDoc, ...writes };
    for (const key of deletedKeys) delete merged[key];
    requestData = merged;
  } else if (operation.data) {
    requestData = partitionDeletes(operation.data).writes;
  }

  return {
    description: `${operation.method} ${operation.path}`,
    expectation: 'ALLOW',
    method: ruleMethod,
    path: operation.path,
    auth: operation.auth ? { uid: operation.auth.uid, token: operation.auth.token } : null,
    data: requestData,
    resource: existingDoc ?? undefined,
    ...(serverTime ? { requestTime: isoFromTimestamp(serverTime) } : {}),
  };
}
