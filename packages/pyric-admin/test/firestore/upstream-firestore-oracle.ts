/**
 * Offline differential oracle for installed `firebase-admin/firestore`
 * (`@google-cloud/firestore`, bundled with `firebase-admin@13.10.0`).
 *
 * -- Two-Layer Offline Oracle Boundary ----------------------------------------
 * 1. Client-side preflight (`acceptedPreflight: false`):
 *    Runs the real installed `firebase-admin/firestore` offline (under
 *    `unshare -rn`) by intercepting `Firestore.prototype.request` and
 *    `Firestore.prototype.requestStream` on the initialized `Firestore` client
 *    before any gRPC/REST socket opens. Every synchronous throw or pre-RPC
 *    rejection comes directly from `@google-cloud/firestore` / `firebase-admin`.
 *
 * 2. Server-side Firestore wire validation (`acceptedPreflight: true`):
 *    Requests that pass client-side serialization reach the intercepted
 *    `commit`, `batchGetDocuments`, `runQuery`, or `rollback` RPC handler,
 *    which enforces Firestore wire-protocol invariants:
 *      - `commit`: resource IDs `.`, `..`, and `__.*__` are rejected with
 *        `INVALID_ARGUMENT`, as are nested `arrayValue` elements inside an
 *        `arrayValue`; `update` on a missing document rejects with `NOT_FOUND`
 *        and `create` on an existing document rejects with `ALREADY_EXISTS`.
 *      - `runQuery`: `limit.value <= 0`, empty `collectionId`, and `IN` /
 *        `NOT_IN` / `ARRAY_CONTAINS_ANY` filters with non-array, empty array,
 *        or `> 30` elements reject with `INVALID_ARGUMENT`.
 *
 * 3. Documented intentional divergences (`packages/conformance/registry/firestore-admin.ts`):
 *    - Row #2: 1-arg `getFirestore(databaseId: string)` named-database selector
 *      is unmodeled (`pyric-admin` rejects non-app first arguments with
 *      `TypeError` per Row #1a).
 *    - Row #4 / #8: Accepted writes (`create`, `set`, `update`, `delete`,
 *      `batch.commit`) resolve to `undefined` in `pyric-admin` vs `WriteResult`
 *      / `WriteResult[]` in `firebase-admin`; comparison normalizes to
 *      `accepted: true`.
 *    - Row #9: Deferred `Firestore` methods (`getAll`, `settings`, etc.) fail
 *      with `PyricDeferredApiError` when upstream accepts.
 *    - `remote-firestore-parity.test.ts` pins synchronous `limit(0)` /
 *      `limitToLast(0)` rejection (`invalid-argument`) rather than replicating
 *      `@google-cloud/firestore`'s falsy-`0` unlimited-query quirk.
 */

import { PassThrough } from 'node:stream';
import {
  applicationDefault,
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
  type App as UpstreamApp,
} from 'firebase-admin/app';
import {
  FieldPath as UpstreamFieldPath,
  FieldValue as UpstreamFieldValue,
  Timestamp as UpstreamTimestamp,
  getFirestore as getUpstreamFirestore,
  type Firestore as UpstreamFirestore,
} from 'firebase-admin/firestore';
import { PyricDeferredApiError } from 'pyric/app/internal';

export interface NormalizedFirestoreOutcome {
  readonly accepted: boolean;
  readonly acceptedPreflight?: boolean;
  readonly errorKind?: 'TypeError' | 'DeferredApiError' | 'FirebaseError' | 'OtherError';
  readonly code?: string;
  readonly message?: string;
}

interface ProtoTimestamp {
  readonly seconds: string;
  readonly nanos: number;
}

interface ProtoValue {
  readonly arrayValue?: { readonly values?: readonly ProtoValue[] };
  readonly mapValue?: { readonly fields?: Readonly<Record<string, ProtoValue>> };
  readonly [key: string]: unknown;
}

interface ProtoWrite {
  readonly update?: {
    readonly name: string;
    readonly fields?: Readonly<Record<string, ProtoValue>>;
  };
  readonly delete?: string;
  readonly currentDocument?: {
    readonly exists?: boolean;
    readonly updateTime?: ProtoTimestamp;
  };
  readonly updateTransforms?: ReadonlyArray<{
    readonly fieldPath: string;
    readonly appendMissingElements?: { readonly values?: readonly ProtoValue[] };
    readonly removeAllFromArray?: { readonly values?: readonly ProtoValue[] };
  }>;
}

interface ProtoCommitRequest {
  readonly writes?: readonly ProtoWrite[];
}

interface ProtoBatchGetRequest {
  readonly documents?: readonly string[];
  readonly newTransaction?: unknown;
}

interface ProtoFieldFilter {
  readonly op?: string;
  readonly value?: ProtoValue;
}

interface ProtoFilter {
  readonly fieldFilter?: ProtoFieldFilter;
  readonly compositeFilter?: { readonly filters?: readonly ProtoFilter[] };
}

interface ProtoRunQueryRequest {
  readonly newTransaction?: unknown;
  readonly structuredQuery?: {
    readonly from?: ReadonlyArray<{ readonly collectionId?: string }>;
    readonly where?: ProtoFilter;
    readonly limit?: { readonly value?: number };
  };
}

const FIXED_PROTO_TIMESTAMP: ProtoTimestamp = {
  seconds: '1700000000',
  nanos: 0,
};

const RESERVED_RESOURCE_ID_RE = /^__.*__$/;
const WIRE_DISJUNCTION_OPS: ReadonlySet<string> = new Set([
  'IN',
  'NOT_IN',
  'ARRAY_CONTAINS_ANY',
]);

function makeGrpcError(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

function extractRelativeSegments(resourceName: string): string[] {
  const marker = '/documents/';
  const idx = resourceName.indexOf(marker);
  if (idx === -1) {
    return [];
  }
  return resourceName.slice(idx + marker.length).split('/');
}

function validateWireResourceSegments(resourceName: string): void {
  const segments = extractRelativeSegments(resourceName);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || RESERVED_RESOURCE_ID_RE.test(segment)) {
      throw makeGrpcError(3, `Resource id "${segment}" is invalid.`);
    }
    if (new TextEncoder().encode(segment).byteLength > 1500) {
      throw makeGrpcError(3, 'The key path element name is longer than 1500 bytes.');
    }
  }
}

function validateProtoValueTree(proto: ProtoValue | undefined, insideArray: boolean): void {
  if (proto === undefined) {
    return;
  }
  if (proto.arrayValue !== undefined) {
    if (insideArray) {
      throw makeGrpcError(3, 'Nested arrays are not supported.');
    }
    const items = proto.arrayValue.values ?? [];
    for (const item of items) {
      validateProtoValueTree(item, true);
    }
    return;
  }
  if (proto.mapValue?.fields !== undefined) {
    for (const child of Object.values(proto.mapValue.fields)) {
      validateProtoValueTree(child, false);
    }
  }
}

function evaluateCommitWireRequest(
  req: ProtoCommitRequest,
  existingDocNames: ReadonlySet<string>,
): { commitTime: ProtoTimestamp; writeResults: Array<{ updateTime: ProtoTimestamp }> } {
  const writes = req.writes ?? [];
  for (const write of writes) {
    const targetName = write.update?.name ?? write.delete;
    if (targetName !== undefined) {
      validateWireResourceSegments(targetName);
    }
    if (write.update?.fields !== undefined) {
      for (const fieldVal of Object.values(write.update.fields)) {
        validateProtoValueTree(fieldVal, false);
      }
    }
    if (write.updateTransforms !== undefined) {
      for (const transform of write.updateTransforms) {
        const unionValues = transform.appendMissingElements?.values ?? [];
        for (const item of unionValues) {
          validateProtoValueTree(item, true);
        }
        const removeValues = transform.removeAllFromArray?.values ?? [];
        for (const item of removeValues) {
          validateProtoValueTree(item, true);
        }
      }
    }
    if (targetName !== undefined && write.currentDocument?.exists === true) {
      if (!existingDocNames.has(targetName)) {
        throw makeGrpcError(5, `No document to update: ${targetName}`);
      }
    }
    if (targetName !== undefined && write.currentDocument?.exists === false) {
      if (existingDocNames.has(targetName)) {
        throw makeGrpcError(6, `Document already exists: ${targetName}`);
      }
    }
  }
  return {
    commitTime: FIXED_PROTO_TIMESTAMP,
    writeResults: writes.map(() => ({ updateTime: FIXED_PROTO_TIMESTAMP })),
  };
}

function validateWireFilter(filter: ProtoFilter | undefined): void {
  if (filter === undefined) {
    return;
  }
  if (filter.compositeFilter?.filters !== undefined) {
    for (const child of filter.compositeFilter.filters) {
      validateWireFilter(child);
    }
  }
  const fieldFilter = filter.fieldFilter;
  if (fieldFilter === undefined) {
    return;
  }
  const op = fieldFilter.op;
  if (op === 'ARRAY_CONTAINS') {
    validateProtoValueTree(fieldFilter.value, true);
    return;
  }
  if (op !== undefined && WIRE_DISJUNCTION_OPS.has(op)) {
    const arrayVal = fieldFilter.value?.arrayValue;
    if (arrayVal === undefined) {
      throw makeGrpcError(3, `${op} requires an ArrayValue.`);
    }
    const elements = arrayVal.values ?? [];
    const maxElements = op === 'NOT_IN' ? 10 : 30;
    if (elements.length === 0 || elements.length > maxElements) {
      throw makeGrpcError(3, `'${op}' supports between 1 and ${maxElements} comparison values.`);
    }
    const elementsMustBeArrayMembers = op === 'ARRAY_CONTAINS_ANY';
    for (const item of elements) {
      validateProtoValueTree(item, elementsMustBeArrayMembers);
    }
    return;
  }
  validateProtoValueTree(fieldFilter.value, false);
}

function validateRunQueryWireRequest(req: ProtoRunQueryRequest): void {
  const structured = req.structuredQuery;
  if (structured === undefined) {
    return;
  }
  for (const selector of structured.from ?? []) {
    if (
      selector.collectionId !== undefined &&
      (typeof selector.collectionId !== 'string' || selector.collectionId === '')
    ) {
      throw makeGrpcError(3, 'CollectionId must be a non-empty string.');
    }
  }
  if (structured.limit?.value !== undefined && structured.limit.value <= 0) {
    throw makeGrpcError(3, 'Limit must be positive.');
  }
  validateWireFilter(structured.where);
}

let upstreamCounter = 0;

export interface OfflineUpstreamFirestoreHarness {
  readonly app: UpstreamApp;
  readonly db: UpstreamFirestore;
  readonly FieldPath: typeof UpstreamFieldPath;
  readonly FieldValue: typeof UpstreamFieldValue;
  readonly Timestamp: typeof UpstreamTimestamp;
  readonly existingDocPath: string;
  readonly nextAbsentDocPath: () => string;
  readonly resetTransportFlag: () => void;
  readonly didReachRpc: () => boolean;
  readonly dispose: () => Promise<void>;
}

export function createOfflineUpstreamFirestoreHarness(): OfflineUpstreamFirestoreHarness {
  const app = initializeUpstreamApp(
    {
      projectId: 'demo-project',
      credential: applicationDefault(),
    },
    `upstream-fs-gen-${++upstreamCounter}`,
  );
  const db = getUpstreamFirestore(app);
  const existingDocPath = 'items/existing';
  const existingResourceName = `projects/demo-project/databases/(default)/documents/${existingDocPath}`;
  const existingDocNames = new Set<string>([existingResourceName]);

  let reachedRpc = false;
  let createSeq = 0;

  const internalDb = db as unknown as {
    request: (methodName: string, req: unknown) => Promise<unknown>;
    requestStream: (
      methodName: string,
      bidirectional: boolean,
      req: unknown,
    ) => Promise<PassThrough>;
  };

  internalDb.request = async (methodName: string, req: unknown): Promise<unknown> => {
    reachedRpc = true;
    if (methodName === 'commit') {
      return evaluateCommitWireRequest(req as ProtoCommitRequest, existingDocNames);
    }
    return {};
  };

  internalDb.requestStream = async (
    methodName: string,
    _bidirectional: boolean,
    req: unknown,
  ): Promise<PassThrough> => {
    reachedRpc = true;
    if (methodName === 'runQuery') {
      validateRunQueryWireRequest(req as ProtoRunQueryRequest);
    }

    const stream = new PassThrough({ objectMode: true });
    stream.pause();

    queueMicrotask(() => {
      if (methodName === 'batchGetDocuments') {
        const batchReq = req as ProtoBatchGetRequest;
        let txBytes: Buffer | undefined;
        if (batchReq.newTransaction !== undefined && batchReq.newTransaction !== null) {
          txBytes = Buffer.from('tx-1');
        }
        for (const docName of batchReq.documents ?? []) {
          if (existingDocNames.has(docName)) {
            stream.write({
              transaction: txBytes,
              found: {
                name: docName,
                fields: {
                  title: { stringValue: 'Seeded' },
                  count: { integerValue: '1' },
                  nested: { mapValue: { fields: { flag: { booleanValue: true } } } },
                },
                createTime: FIXED_PROTO_TIMESTAMP,
                updateTime: FIXED_PROTO_TIMESTAMP,
              },
              readTime: FIXED_PROTO_TIMESTAMP,
            });
          } else {
            stream.write({
              transaction: txBytes,
              missing: docName,
              readTime: FIXED_PROTO_TIMESTAMP,
            });
          }
        }
        stream.end();
        return;
      }

      if (methodName === 'runQuery') {
        const queryReq = req as ProtoRunQueryRequest;
        let txBytes: Buffer | undefined;
        if (queryReq.newTransaction !== undefined && queryReq.newTransaction !== null) {
          txBytes = Buffer.from('tx-1');
        }
        stream.write({
          transaction: txBytes,
          readTime: FIXED_PROTO_TIMESTAMP,
        });
        stream.end();
        return;
      }

      stream.end();
    });

    return stream;
  };

  return {
    app,
    db,
    FieldPath: UpstreamFieldPath,
    FieldValue: UpstreamFieldValue,
    Timestamp: UpstreamTimestamp,
    existingDocPath,
    nextAbsentDocPath: () => `items/fresh-${++createSeq}`,
    resetTransportFlag: () => {
      reachedRpc = false;
    },
    didReachRpc: () => reachedRpc,
    dispose: async () => {
      await deleteUpstreamApp(app).catch(() => {});
    },
  };
}

function hasErrorCode(error: unknown): error is { code: string | number } {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' || typeof code === 'number';
}

function classifyFirestoreError(error: unknown): {
  errorKind: 'TypeError' | 'DeferredApiError' | 'FirebaseError' | 'OtherError';
  code?: string;
  message: string;
} {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  if (error instanceof PyricDeferredApiError) {
    return { errorKind: 'DeferredApiError', message };
  }
  if (error instanceof TypeError) {
    return { errorKind: 'TypeError', message };
  }
  if (hasErrorCode(error)) {
    return { errorKind: 'FirebaseError', code: String(error.code), message };
  }
  return { errorKind: 'OtherError', message };
}

function readTransportState(didReachTransport?: () => boolean): boolean | undefined {
  if (didReachTransport === undefined) {
    return undefined;
  }
  return didReachTransport();
}

export async function captureFirestoreOutcome(
  invoke: () => unknown,
  didReachTransport?: () => boolean,
): Promise<NormalizedFirestoreOutcome> {
  try {
    await invoke();
    return {
      accepted: true,
      acceptedPreflight: readTransportState(didReachTransport),
    };
  } catch (error) {
    const info = classifyFirestoreError(error);
    return {
      accepted: false,
      acceptedPreflight: readTransportState(didReachTransport),
      errorKind: info.errorKind,
      code: info.code,
      message: info.message,
    };
  }
}

export interface OutcomeComparisonOptions {
  readonly allowDeferredWhenUpstreamAccepts?: boolean;
  readonly allowZeroLimitRejectionWhenUpstreamAccepts?: boolean;
  readonly allowCommittedBatchSecondCommitRejection?: boolean;
  readonly allowNamedDatabaseOverloadDiff?: boolean;
  readonly rawFirstArg?: unknown;
}

export function compareFirestoreOutcomes(
  contextLabel: string,
  upstream: NormalizedFirestoreOutcome,
  pyric: NormalizedFirestoreOutcome,
  options: OutcomeComparisonOptions = {},
): string | null {
  if (
    options.allowDeferredWhenUpstreamAccepts === true &&
    upstream.accepted &&
    !pyric.accepted &&
    pyric.errorKind === 'DeferredApiError'
  ) {
    return null;
  }

  if (
    options.allowZeroLimitRejectionWhenUpstreamAccepts === true &&
    upstream.accepted &&
    !pyric.accepted &&
    (pyric.code === '3' || pyric.code === 'invalid-argument')
  ) {
    return null;
  }

  if (
    options.allowCommittedBatchSecondCommitRejection === true &&
    upstream.accepted &&
    !pyric.accepted &&
    (pyric.code === '9' || pyric.code === 'failed-precondition')
  ) {
    return null;
  }

  if (
    options.allowNamedDatabaseOverloadDiff === true &&
    typeof options.rawFirstArg === 'string' &&
    upstream.accepted &&
    !pyric.accepted &&
    pyric.errorKind === 'TypeError'
  ) {
    return null;
  }

  if (upstream.accepted !== pyric.accepted) {
    const uSummary = `${upstream.accepted} (${upstream.errorKind ?? 'ok'}:${upstream.code ?? ''}:${upstream.message ?? ''})`;
    const pSummary = `${pyric.accepted} (${pyric.errorKind ?? 'ok'}:${pyric.code ?? ''}:${pyric.message ?? ''})`;
    return `${contextLabel}: acceptance mismatch [upstream=${uSummary} | pyric=${pSummary}]`;
  }

  return null;
}
