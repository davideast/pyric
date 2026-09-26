import type { DocStore, DocumentData } from './local-state.js';
import type { Operation } from './writes.js';
import { partitionDeletes } from './value-resolver.js';
import { applyMerge, applyUpdate } from './field-merge.js';
import type { TestCase, Timestamp } from 'pyric/rules/internal';
import { isoFromTimestamp } from './rules-evaluation.js';

/**
 * The document a single write leaves behind, which rules read as
 * `request.resource.data`. An update applies each top-level key as a field
 * path and a merge set deep-merges nested maps, through the same functions
 * the store uses, so the evaluated document is the stored one.
 */
function projectRequestData(
  operation: Operation,
  existingDoc: DocumentData | null,
): DocumentData | undefined {
  const { method, data, merge } = operation;
  if (method === 'get' || method === 'list') return undefined;
  if (!data) return data;
  const isMergeSet = merge !== undefined && merge !== false
    && (method === 'create' || method === 'update');
  if (isMergeSet) {
    const mergeFields = merge === true ? undefined : merge.mergeFields;
    return applyMerge(existingDoc ?? {}, data, mergeFields);
  }
  if (method === 'update' && existingDoc) return applyUpdate(existingDoc, data);
  return partitionDeletes(data).writes;
}

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

  return {
    description: `${operation.method} ${operation.path}`,
    expectation: 'ALLOW',
    method: ruleMethod,
    path: operation.path,
    auth: operation.auth ? { uid: operation.auth.uid, token: operation.auth.token } : null,
    data: projectRequestData(operation, existingDoc),
    resource: existingDoc ?? undefined,
    ...(serverTime ? { requestTime: isoFromTimestamp(serverTime) } : {}),
  };
}
