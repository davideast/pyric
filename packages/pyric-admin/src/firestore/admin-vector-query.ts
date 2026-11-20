/**
 * Admin-SDK `Query.findNearest` (`VectorQuery`) k-NN evaluation across local
 * and JSON-wire remote sandboxes (`EUCLIDEAN`, `COSINE`, `DOT_PRODUCT`).
 */

import { SandboxError } from 'pyric/sandbox';
import type {
  QueryDocumentSnapshot,
  QuerySnapshot,
  SnapshotFieldPath,
} from 'pyric/sandbox/admin-compat';
import { executeQueryExplain, readProjectedNested } from './admin-query-extensions.js';
import { isAdminVectorValue, type AdminVectorValue } from './admin-vector-and-errors.js';
import { isPlainDocumentObject, validateStringOrFieldPath } from './admin-write-validation.js';

type VectorDistanceMeasure = 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';

interface AdminFindNearestOptions {
  readonly vectorField?: string | SnapshotFieldPath;
  readonly queryVector?: readonly number[] | AdminVectorValue;
  readonly limit: number;
  readonly distanceMeasure: VectorDistanceMeasure;
  readonly distanceResultField?: string | SnapshotFieldPath;
  readonly distanceThreshold?: number;
}

const VALID_MEASURES = new Set<string>(['EUCLIDEAN', 'COSINE', 'DOT_PRODUCT']);

function computeVectorDistance(
  left: readonly number[],
  right: readonly number[],
  measure: VectorDistanceMeasure,
): number {
  let dot = 0;
  let sumSqDiff = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] as number;
    const b = right[i] as number;
    dot += a * b;
    const diff = a - b;
    sumSqDiff += diff * diff;
    normA += a * a;
    normB += b * b;
  }
  if (measure === 'EUCLIDEAN') return Math.sqrt(sumSqDiff);
  if (measure === 'DOT_PRODUCT') return -dot;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

export function buildAdminVectorQuery(
  baseQuery: { isEqual(other: unknown): boolean },
  fetchSnapshot: () => Promise<QuerySnapshot>,
  wrapFilteredDocs: (docs: readonly QueryDocumentSnapshot[]) => QuerySnapshot,
  arg0: unknown,
  arg1?: unknown,
  arg2?: unknown,
): Record<string, unknown> {
  let rawField: unknown = arg0;
  let rawVector: unknown = arg1;
  let opts: AdminFindNearestOptions | undefined = arg2 as AdminFindNearestOptions | undefined;
  if (isPlainDocumentObject(arg0) && arg1 === undefined) {
    rawField = arg0.vectorField;
    rawVector = arg0.queryVector;
    opts = arg0 as unknown as AdminFindNearestOptions;
  }
  const fieldSegments = validateStringOrFieldPath('vectorField', rawField);
  if (opts === undefined || typeof opts.limit !== 'number' || !Number.isInteger(opts.limit) || opts.limit <= 0 || opts.limit > 1000) {
    throw new SandboxError('invalid-argument', 'Value for argument "limit" must be an integer between 1 and 1000.');
  }
  if (!VALID_MEASURES.has(opts.distanceMeasure)) {
    throw new SandboxError('invalid-argument', 'Value for argument "distanceMeasure" is invalid.');
  }
  let targetVec: number[];
  if (isAdminVectorValue(rawVector)) {
    targetVec = rawVector.toArray();
  } else if (Array.isArray(rawVector)) {
    targetVec = rawVector.map((n, i) => {
      if (typeof n !== 'number') throw new SandboxError('invalid-argument', `Vector element ${i} must be a number.`);
      return n;
    });
  } else {
    throw new SandboxError('invalid-argument', 'Value for argument "queryVector" must be a VectorValue or number[].');
  }
  if (targetVec.length === 0) {
    throw new SandboxError('invalid-argument', 'Value for argument "queryVector" must have length > 0.');
  }
  const measure = opts.distanceMeasure;
  const maxResults = opts.limit;
  const threshold = opts.distanceThreshold;
  const sig = `${fieldSegments.join('.')}:${measure}:${maxResults}:${JSON.stringify(targetVec)}`;

  const runVectorGet = async (): Promise<QuerySnapshot> => {
    const snap = await fetchSnapshot();
    const scored: Array<{ doc: QueryDocumentSnapshot; dist: number }> = [];
    for (const doc of snap.docs) {
      const candidateVal = readProjectedNested(doc.data(), fieldSegments).value;
      if (!isAdminVectorValue(candidateVal)) continue;
      const arr = candidateVal.toArray();
      if (arr.length !== targetVec.length) continue;
      const dist = computeVectorDistance(arr, targetVec, measure);
      if (threshold !== undefined && dist > threshold) continue;
      scored.push({ doc, dist });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return wrapFilteredDocs(scored.slice(0, maxResults).map((s) => s.doc));
  };

  const vectorQuery: Record<string, unknown> = {
    query: baseQuery,
    _sig: sig,
    isEqual(other: unknown): boolean {
      if (other === vectorQuery) return true;
      if (typeof other !== 'object' || other === null) return false;
      const cand = other as { query?: unknown; _sig?: string };
      return baseQuery.isEqual(cand.query) && cand._sig === sig;
    },
    get: runVectorGet,
    explain: (explainOpts?: { readonly analyze?: boolean }) =>
      executeQueryExplain(explainOpts, runVectorGet),
  };
  return vectorQuery;
}
