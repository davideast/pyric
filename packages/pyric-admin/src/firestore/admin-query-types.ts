/**
 * Public TypeScript surface interfaces for `pyric-admin/firestore` query,
 * collection, document, aggregate, and converter handles.
 */

import type { Readable } from 'node:stream';
import type {
  AggregateField as CompatAggregateField,
  AggregateQuerySnapshot as CompatAggregateQuerySnapshot,
  AggregateSpec,
  CollectionReference as CompatCollectionReference,
  DocumentData,
  DocumentReference as CompatDocumentReference,
  DocumentSnapshot,
  Filter as CompatFilter,
  LiveDocumentSnapshot,
  LiveQuerySnapshot,
  OperationOptions,
  OrderDirection,
  Query as CompatQuery,
  QueryDocumentSnapshot,
  QuerySnapshot,
  SetOptions,
  SnapshotFieldPath,
  Timestamp,
  WhereFilterOp,
} from 'pyric/sandbox/admin-compat';
import type {
  SandboxFirestore,
  SnapshotListenOptions,
  SnapshotObserver,
  Unsubscribe,
} from 'pyric/sandbox/admin-firestore';
import type {
  AdminBulkWriter,
  BulkWriterOptions,
} from './admin-bulk-writer.js';
import type { AdminFirestoreDataConverter } from './admin-converter-and-discovery.js';
import type { AggregateField, Filter } from './admin-filter-aggregate-cursors.js';
import type { AdminFirestoreSettings } from './admin-settings-lifecycle.js';
import type { AdminVectorValue } from './admin-vector-and-errors.js';
import type { WriteResult } from './admin-write-result-preconditions.js';

export interface AdminAggregateQuerySnapshot {
  readonly query: AdminQuery;
  readonly readTime: Timestamp;
  data(): Record<string, number | null>;
  isEqual(other: unknown): boolean;
}

export interface AdminAggregateQuery {
  readonly query: AdminQuery;
  get(): Promise<AdminAggregateQuerySnapshot>;
  isEqual(other: unknown): boolean;
  explain(options?: { readonly analyze?: boolean }): Promise<unknown>;
}

export interface AdminExplainMetrics {
  readonly planSummary: {
    readonly indexesUsed: ReadonlyArray<Record<string, unknown>>;
  };
  readonly executionStats: {
    readonly resultsReturned: number;
    readonly executionDuration: { readonly seconds: number; readonly nanoseconds: number };
    readonly readOperations: number;
    readonly debugStats: Record<string, unknown>;
  } | null;
}

export interface AdminExplainResults<T = DocumentData> {
  readonly metrics: AdminExplainMetrics;
  readonly snapshot: AdminQuerySnapshot<T> | null;
}

export type AdminVectorDistanceMeasure = 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';

export interface AdminFindNearestOptions {
  readonly vectorField?: string | SnapshotFieldPath;
  readonly queryVector?: readonly number[] | AdminVectorValue;
  readonly limit: number;
  readonly distanceMeasure: AdminVectorDistanceMeasure;
  readonly distanceResultField?: string | SnapshotFieldPath;
  readonly distanceThreshold?: number;
}

export interface AdminVectorQuery<T = DocumentData> {
  readonly query: AdminQuery<T>;
  get(): Promise<AdminQuerySnapshot<T>>;
  isEqual(other: unknown): boolean;
  explain(options?: { readonly analyze?: boolean }): Promise<AdminExplainResults<T>>;
}

export interface AdminQueryDocumentSnapshot<T = DocumentData>
  extends Omit<QueryDocumentSnapshot, 'data' | 'ref'> {
  readonly ref: AdminDocumentReference<T>;
  readonly createTime: Timestamp;
  readonly updateTime: Timestamp;
  readonly readTime: Timestamp;
  data(): T;
  isEqual(other: unknown): boolean;
}

export interface AdminDocumentSnapshot<T = DocumentData>
  extends Omit<DocumentSnapshot, 'data' | 'ref'> {
  readonly ref: AdminDocumentReference<T>;
  readonly createTime?: Timestamp;
  readonly updateTime?: Timestamp;
  readonly readTime: Timestamp;
  data(): T | undefined;
  isEqual(other: unknown): boolean;
}

export interface AdminQuerySnapshot<T = DocumentData>
  extends Omit<QuerySnapshot, 'docs' | 'forEach' | 'docChanges'> {
  readonly query: AdminQuery<T>;
  readonly readTime: Timestamp;
  readonly docs: ReadonlyArray<AdminQueryDocumentSnapshot<T>>;
  forEach(callback: (result: AdminQueryDocumentSnapshot<T>) => void, thisArg?: unknown): void;
  docChanges(options?: { includeMetadataChanges?: boolean }): Array<{
    type: 'added' | 'modified' | 'removed';
    doc: AdminQueryDocumentSnapshot<T>;
    oldIndex: number;
    newIndex: number;
  }>;
  isEqual(other: unknown): boolean;
}

export interface AdminQuery<T = DocumentData>
  extends Omit<
    CompatQuery,
    | 'where'
    | 'applyFilter'
    | 'orderBy'
    | 'limit'
    | 'limitToLast'
    | 'startCursor'
    | 'endCursor'
    | 'startCursorFromSnapshot'
    | 'endCursorFromSnapshot'
    | 'get'
    | 'aggregate'
  > {
  readonly firestore: AdminFirestore;
  where(filter: Filter): AdminQuery<T>;
  where(field: SnapshotFieldPath, op: WhereFilterOp, value: unknown): AdminQuery<T>;
  applyFilter(filter: CompatFilter): AdminQuery<T>;
  orderBy(field: SnapshotFieldPath, direction?: OrderDirection): AdminQuery<T>;
  limit(n: number): AdminQuery<T>;
  limitToLast(n: number): AdminQuery<T>;
  offset(offset: number): AdminQuery<T>;
  select(...fieldPaths: Array<string | SnapshotFieldPath>): AdminQuery<DocumentData>;
  startAt(...fieldValuesOrDocumentSnapshot: unknown[]): AdminQuery<T>;
  startAfter(...fieldValuesOrDocumentSnapshot: unknown[]): AdminQuery<T>;
  endAt(...fieldValuesOrDocumentSnapshot: unknown[]): AdminQuery<T>;
  endBefore(...fieldValuesOrDocumentSnapshot: unknown[]): AdminQuery<T>;
  startCursor(values: unknown[], inclusive: boolean, fromSnapshot?: boolean): AdminQuery<T>;
  endCursor(values: unknown[], inclusive: boolean, fromSnapshot?: boolean): AdminQuery<T>;
  startCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): AdminQuery<T>;
  endCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): AdminQuery<T>;
  count(): AdminAggregateQuery;
  aggregate(
    spec: Record<string, AggregateField | CompatAggregateField>,
  ): AdminAggregateQuery & Promise<CompatAggregateQuerySnapshot>;
  get(opts?: OperationOptions): Promise<AdminQuerySnapshot<T>>;
  stream(): Readable;
  explain(options?: { readonly analyze?: boolean }): Promise<AdminExplainResults<T>>;
  explainStream(options?: { readonly analyze?: boolean }): Readable;
  findNearest(
    vectorField: string | SnapshotFieldPath,
    queryVector: readonly number[] | AdminVectorValue,
    options: {
      readonly limit: number;
      readonly distanceMeasure: AdminVectorDistanceMeasure;
      readonly distanceResultField?: string | SnapshotFieldPath;
      readonly distanceThreshold?: number;
    },
  ): AdminVectorQuery<T>;
  findNearest(options: AdminFindNearestOptions): AdminVectorQuery<T>;
  onSnapshot(
    onNext: (snapshot: LiveQuerySnapshot) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  onSnapshot(observer: SnapshotObserver<LiveQuerySnapshot>): Unsubscribe;
  onSnapshot(
    options: SnapshotListenOptions,
    onNext: (snapshot: LiveQuerySnapshot) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  onSnapshot(
    options: SnapshotListenOptions,
    observer: SnapshotObserver<LiveQuerySnapshot>,
  ): Unsubscribe;
  isEqual(other: unknown): boolean;
  withConverter(converter: null): AdminQuery<DocumentData>;
  withConverter<U>(converter: AdminFirestoreDataConverter<U>): AdminQuery<U>;
}

export interface AdminCollectionGroup<T = DocumentData> extends AdminQuery<T> {
  getPartitions(desiredPartitionCount: number): AsyncIterable<unknown>;
  withConverter(converter: null): AdminCollectionGroup<DocumentData>;
  withConverter<U>(converter: AdminFirestoreDataConverter<U>): AdminCollectionGroup<U>;
}

export interface AdminCollectionReference<T = DocumentData> extends AdminQuery<T> {
  readonly id: string;
  readonly path: string;
  readonly parent: AdminDocumentReference | null;
  doc(id?: string): AdminDocumentReference<T>;
  add(data: T, opts?: OperationOptions): Promise<AdminDocumentReference<T>>;
  listDocuments(): Promise<Array<AdminDocumentReference<T>>>;
  withConverter(converter: null): AdminCollectionReference<DocumentData>;
  withConverter<U>(converter: AdminFirestoreDataConverter<U>): AdminCollectionReference<U>;
}

export interface AdminDocumentReference<T = DocumentData>
  extends Omit<
    CompatDocumentReference,
    'parent' | 'collection' | 'get' | 'create' | 'set' | 'update' | 'delete'
  > {
  readonly firestore: AdminFirestore;
  readonly formattedName: string;
  readonly parent: AdminCollectionReference<T>;
  collection(name: string): AdminCollectionReference<DocumentData>;
  get(opts?: OperationOptions): Promise<AdminDocumentSnapshot<T>>;
  create(data: T, opts?: OperationOptions): Promise<WriteResult>;
  set(data: Partial<T>, options: SetOptions): Promise<WriteResult>;
  set(data: T, options?: SetOptions): Promise<WriteResult>;
  update(data: DocumentData, precondition?: OperationOptions): Promise<WriteResult>;
  update(
    field: string | SnapshotFieldPath,
    value: unknown,
    ...moreFieldsOrPrecondition: unknown[]
  ): Promise<WriteResult>;
  delete(opts?: OperationOptions): Promise<WriteResult>;
  listCollections(): Promise<AdminCollectionReference[]>;
  onSnapshot(
    onNext: (snapshot: LiveDocumentSnapshot) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  onSnapshot(observer: SnapshotObserver<LiveDocumentSnapshot>): Unsubscribe;
  onSnapshot(
    options: SnapshotListenOptions,
    onNext: (snapshot: LiveDocumentSnapshot) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
  onSnapshot(
    options: SnapshotListenOptions,
    observer: SnapshotObserver<LiveDocumentSnapshot>,
  ): Unsubscribe;
  isEqual(other: unknown): boolean;
  withConverter(converter: null): AdminDocumentReference<DocumentData>;
  withConverter<U>(converter: AdminFirestoreDataConverter<U>): AdminDocumentReference<U>;
}

export interface AdminFirestore
  extends Omit<SandboxFirestore, 'collection' | 'doc' | 'collectionGroup'> {
  collection(path: string): AdminCollectionReference<DocumentData> & CompatCollectionReference;
  doc(path: string): AdminDocumentReference<DocumentData> & CompatDocumentReference;
  collectionGroup(collectionId: string): AdminCollectionGroup<DocumentData> & CompatQuery;
  settings(settings: AdminFirestoreSettings): void;
  terminate(): Promise<void>;
  getAll(
    ...documentRefsOrReadOptions: Array<CompatDocumentReference | { readonly fieldMask?: ReadonlyArray<string | SnapshotFieldPath> }>
  ): Promise<Array<AdminDocumentSnapshot<DocumentData>>>;
  listCollections(): Promise<AdminCollectionReference[]>;
  recursiveDelete(
    ref: CompatDocumentReference | CompatCollectionReference,
    bulkWriter?: AdminBulkWriter,
  ): Promise<void>;
  bulkWriter(options?: BulkWriterOptions): AdminBulkWriter;
  bundle(bundleId?: string): unknown;
}

export type { AdminFirestoreDataConverter as FirestoreDataConverter };
