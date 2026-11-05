/**
 * Firestore composite-index wire types.
 *
 * Mirrors the shape used by `firebase-tools/src/firestore/api-types.ts` and
 * the v1 REST API at
 * `firestore.googleapis.com/v1/projects/{p}/databases/{d}/collectionGroups/{g}/indexes`.
 *
 * The `firestore.indexes.json` file (the Firebase config file consumed by
 * `firebase deploy --only firestore:indexes`) wraps these types with a
 * top-level `indexes`/`fieldOverrides` envelope and adds a
 * `collectionGroup` field to each entry. That shape is captured by
 * `IndexesConfig` below.
 */

export type QueryScope = 'COLLECTION' | 'COLLECTION_GROUP';
export type IndexFieldOrder = 'ASCENDING' | 'DESCENDING';
export type ArrayConfig = 'CONTAINS';
export type IndexState = 'CREATING' | 'READY' | 'NEEDS_REPAIR';

export type ApiScope =
  | 'ANY_API'
  | 'DATASTORE_MODE_API'
  | 'MONGODB_COMPATIBLE_API';

export type Density =
  | 'DENSE'
  | 'SPARSE_ALL'
  | 'SPARSE_ANY'
  | 'DENSITY_UNSPECIFIED';

export interface VectorConfig {
  dimension: number;
  flat?: Record<string, never>;
}

export interface IndexField {
  fieldPath: string;
  order?: IndexFieldOrder;
  arrayConfig?: ArrayConfig;
  vectorConfig?: VectorConfig;
}

/** REST wire shape — the body posted to .../indexes. */
export interface Index {
  /** Server-assigned. Present on read responses, not on create requests. */
  name?: string;
  queryScope: QueryScope;
  fields: IndexField[];
  /** Server-assigned. */
  state?: IndexState;
  apiScope?: ApiScope;
  density?: Density;
  multikey?: boolean;
  unique?: boolean;
}

/**
 * The shape of `firestore.indexes.json`. Each entry adds `collectionGroup`
 * (which the wire format conveys via the URL `parent` parameter, not the
 * body) so the file is self-describing.
 */
export interface IndexesConfigEntry extends Index {
  collectionGroup: string;
}

export interface IndexesConfig {
  indexes: IndexesConfigEntry[];
  fieldOverrides?: unknown[];
}

/**
 * Long-running-operation handle returned by index creation. The full
 * Operation resource has more fields; we only need name + done state for
 * polling. See google.longrunning.Operation.
 */
export interface IndexOperation {
  /** `projects/.../operations/<id>` — opaque. Use to poll status. */
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  /** When done and successful, response is the created Index. */
  response?: Index;
}
