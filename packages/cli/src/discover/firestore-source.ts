/**
 * Credential-neutral Firestore seam for discovery.
 *
 * The crawler depends only on these structural shapes. Sandbox snapshots,
 * LocalEnvironment, production REST, and test fixtures each provide an
 * adapter without teaching the discovery implementation how that data was
 * obtained. Keep credentials, tokens, SDK initialization, and network policy
 * out of this module.
 */

/** Minimal document snapshot shape needed for wire-type inference. */
export interface WireDocumentSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _fieldsProto?: Record<string, any>;
  ref?: { path?: string };
}

/** Minimal collection-reference shape needed for traversal. */
export interface CrawlerCollectionRef {
  readonly id: string;
  readonly path: string;
  listDocuments(): Promise<CrawlerDocumentRef[]>;
}

/** Minimal document-reference shape needed for traversal and sampling. */
export interface CrawlerDocumentRef {
  readonly id: string;
  readonly path: string;
  listCollections(): Promise<CrawlerCollectionRef[]>;
  get(): Promise<WireDocumentSnapshot>;
}

/**
 * Firestore-shaped source consumed by the crawler.
 *
 * `collection` and `doc` are needed only when resuming a continuation.
 */
export interface CrawlerFirestore {
  listCollections(): Promise<CrawlerCollectionRef[]>;
  collection?(path: string): CrawlerCollectionRef;
  doc?(path: string): CrawlerDocumentRef;
}

/** Minimal collection-group query shape used by host discovery. */
export interface CollectionGroupQuery {
  select(...fields: string[]): CollectionGroupQuery;
  limit(n: number): CollectionGroupQuery;
  get(): Promise<{ docs: CollectionGroupSnapshot[] }>;
}

/** Parent-path projection used by collection-group discovery. */
export interface CollectionGroupSnapshot {
  ref: { parent: { path: string } };
}

/** Optional source capability used by `findCollectionGroup`. */
export interface CollectionGroupCapableFirestore {
  collectionGroup(collectionId: string): CollectionGroupQuery;
}
