/**
 * Persistence module barrel — public surface re-exported from the
 * package root. Backends are exposed so hosts that need a custom
 * adapter (filesystem, remote KV) can compose against the same
 * contract.
 */
export type { PersistenceBackend, SandboxPersistenceOptions, WebStorageLike } from './types.js';
export { createIndexedDBBackend, createMemoryBackend, recordBackendOverBlob } from './backends.js';
export { serializeToBuckets, deserializeFromBuckets, bundleRecords, parseBundle } from './chunk-format.js';
export { PersistenceSchemaError, rehydrateDocValue } from './serialize.js';
export type { PersistenceController } from './controller.js';
export { attachPersistence } from './controller.js';
