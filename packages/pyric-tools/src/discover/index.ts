/**
 * Barrel for the discover crawler — see ../discover.ts for the
 * subpath entry and rationale.
 */

export * from './crawler.js';
export * from './findCollectionGroup.js';
export * from './wire.js';
export * from './types.js';
export * from './session.js';
export * from './concurrency.js';
export * from './merge.js';
// Crawler adapter — wraps LocalEnvironment as a CrawlerFirestore so
// the discover tools can run hermetically against the sandbox.
export * from './crawler-adapter.js';
// ToolHandler factory — `firestore_discover_paths` +
// `firestore_find_collection_group`. Browser-safe.
export * from './tools.js';
// REST-backed CrawlerFirestore — required because the modular Web SDK
// has no `listCollections()` API (admin-only). Any non-admin environment
// with an OAuth access token (browser, edge runtime, plain Node script
// without firebase-admin) uses this to satisfy the crawler's structural
// `CrawlerFirestore` contract.
export * from './rest-crawler-firestore.js';
