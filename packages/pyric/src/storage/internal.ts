/**
 * `pyric/storage/internal` — host-only admin plane for the sandbox
 * storage backend.
 *
 * The public `pyric/storage` surface is deliberately rules-honest:
 * every operation on a handle from `getStorageSandbox` evaluates the
 * configured storage rules against the handle's context identity.
 * Hosts that must serve firebase-admin semantics (the SharedWorker
 * host resolving `actAs: { mode: 'admin' }` storage ops for
 * `pyric-admin`'s remote dispatch arm, Pyric Studio's admin lens)
 * need a rules-BYPASS handle onto the SAME per-sandbox store.
 *
 * This subpath exists so that bypass never leaks onto the public
 * modular surface — mirroring how `pyric/sandbox/internal` carries
 * the sandbox's host-only seams.
 */

export {
  bindStorageOperationContext,
  getAdminStorageSandbox,
  getStorageRulesResolution,
} from './service.js';
export {
  decodeString,
  defaultRawContentType,
} from './upload.js';
export type { StorageRulesResolution } from './rules-resolution.js';
