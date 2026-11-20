/**
 * Admin-SDK `Query.{select, offset, stream, explain, explainStream}` helpers
 * across local and JSON-wire remote sandboxes.
 */

import { Readable } from 'node:stream';
import { SandboxError } from 'pyric/sandbox';
import type {
  DocumentData,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'pyric/sandbox/admin-compat';
import { isPlainMap } from './admin-handle-registry.js';
import { validateStringOrFieldPath } from './admin-write-validation.js';

export function validateAdminOffsetInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "offset" is not a valid integer.',
    );
  }
  return value;
}

export function parseSelectFieldPaths(fields: readonly unknown[]): Array<readonly string[]> {
  return fields.map((entry, idx) => validateStringOrFieldPath(idx, entry));
}

export function readProjectedNested(
  source: DocumentData,
  segments: readonly string[],
): { readonly found: boolean; readonly value: unknown } {
  let cursor: unknown = source;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, seg)) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return { found: true, value: cursor };
}

export function projectDataByFieldPaths(
  source: DocumentData,
  fieldPaths: ReadonlyArray<readonly string[]>,
): DocumentData {
  const result: Record<string, unknown> = {};
  for (const segments of fieldPaths) {
    const resolved = readProjectedNested(source, segments);
    if (!resolved.found) continue;
    let target = result;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      if (!isPlainMap(target[seg])) {
        target[seg] = {};
      }
      target = target[seg] as Record<string, unknown>;
    }
    target[segments[segments.length - 1] as string] = resolved.value;
  }
  return result;
}

export function createQueryStream(
  pendingLimitType: 'none' | 'first' | 'last',
  fetchSnapshot: () => Promise<QuerySnapshot>,
): Readable {
  if (pendingLimitType === 'last') {
    throw new Error('Results for limitToLast queries cannot be streamed via the stream() API.');
  }
  async function* generateDocs(): AsyncGenerator<QueryDocumentSnapshot> {
    const snap = await fetchSnapshot();
    for (const doc of snap.docs) {
      yield doc;
    }
  }
  return Readable.from(generateDocs(), { objectMode: true });
}

export async function executeQueryExplain(
  options: { readonly analyze?: boolean } | undefined,
  fetchSnapshot: () => Promise<QuerySnapshot>,
): Promise<Record<string, unknown>> {
  if (options?.analyze === true) {
    const snapshot = await fetchSnapshot();
    return {
      metrics: {
        planSummary: {
          indexesUsed: [{ properties: '(__name__ ASC)', query_scope: 'Collection' }],
        },
        executionStats: {
          resultsReturned: snapshot.size,
          executionDuration: { seconds: 0, nanoseconds: 0 },
          readOperations: Math.max(1, snapshot.size),
          debugStats: {},
        },
      },
      snapshot,
    };
  }
  return {
    metrics: {
      planSummary: { indexesUsed: [] },
      executionStats: null,
    },
    snapshot: null,
  };
}

export function createQueryExplainStream(
  pendingLimitType: 'none' | 'first' | 'last',
  options: { readonly analyze?: boolean } | undefined,
  fetchSnapshot: () => Promise<QuerySnapshot>,
): Readable {
  if (pendingLimitType === 'last') {
    throw new Error(
      'Query results for queries that include limitToLast() constraints cannot be streamed. Use Query.explain() instead.',
    );
  }
  async function* generateExplainChunks(): AsyncGenerator<Record<string, unknown>> {
    if (options?.analyze === true) {
      const snapshot = await fetchSnapshot();
      for (const doc of snapshot.docs) {
        yield { document: doc, metrics: undefined };
      }
      yield {
        document: undefined,
        metrics: {
          planSummary: {
            indexesUsed: [{ properties: '(__name__ ASC)', query_scope: 'Collection' }],
          },
          executionStats: {
            resultsReturned: snapshot.size,
            executionDuration: { seconds: 0, nanoseconds: 0 },
            readOperations: Math.max(1, snapshot.size),
            debugStats: {},
          },
        },
      };
      return;
    }
    yield {
      document: undefined,
      metrics: {
        planSummary: { indexesUsed: [] },
        executionStats: null,
      },
    };
  }
  return Readable.from(generateExplainChunks(), { objectMode: true });
}
