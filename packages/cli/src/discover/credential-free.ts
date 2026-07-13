/**
 * Credential-free discovery implementation.
 *
 * This is the internal composition seam for traversal, grouping, schema
 * inference, convergence, tool handlers, and sandbox adapters. It must remain
 * importable without production REST, auth/token modules, or Firebase SDKs.
 * The public `@pyric/cli/discover` entry exposes only this retained module;
 * the production adapter lives at a separate temporary entry for issue #265.
 */

export type {
  WireDocumentSnapshot,
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
  CollectionGroupQuery,
  CollectionGroupSnapshot,
  CollectionGroupCapableFirestore,
} from './firestore-source.js';
export * from './crawler.js';
export * from './findCollectionGroup.js';
export * from './wire.js';
export * from './types.js';
export * from './session.js';
export * from './concurrency.js';
export * from './merge.js';
export * from './crawler-adapter.js';
export * from './tools.js';
