/**
 * `pyric/storage` — Firebase Storage adapter for the Pyric sandbox.
 *
 * Sibling-package layout mirrors Firebase:
 *   `firebase/app`     ↔ `firebase/storage`
 *   `pyric/sandbox`   ↔ `pyric/storage`
 *
 * Public surface lands incrementally through the slices in
 * the design rationale:
 *
 *   - Slice 4: `getStorage`, `FirebaseStorage`
 *   - Slice 5 (here): `ref`, `uploadBytes`, `uploadString`,
 *     `getBytes`, `getBlob`, `deleteObject`, `StorageReference`,
 *     `SettableMetadata`, `FullMetadata`, `UploadResult`
 *   - Slice 6: `getMetadata`, `updateMetadata`
 *   - Slice 7: `listAll`, `ListResult`
 *   - Slice 8: rules support via `getStorage(ctx, { rules })`
 *   - Slice 9: end-to-end session-archive demo + README
 *
 * Out of scope for the v1 scope (see README): `getDownloadURL`,
 * paginated `list`, `uploadBytesResumable`, Admin SDK shape,
 * Storage emulator parity, image transformations, Cloud Functions
 * triggers.
 */

import { getStorageSandbox, getStorageProd } from './service.js';
import type { FirebaseStorage } from './service.js';

// Phase 3 unified app handle. Adapter dispatch reads `APP_TARGET` and
// routes to the existing direct-handle path (sandbox vs prod).
import { APP_TARGET, type PyricApp } from 'pyric/app';

export { getStorageSandbox, getStorageProd, TARGET_SYMBOL } from './service.js';
export type { FirebaseStorage, StorageOptions, ProdStorageOptions, Target, SandboxTarget, ProdTarget } from './service.js';

// ─── Phase 3 unified getStorage(PyricApp) dispatch ───────────────────
//
// `getStorageSandbox(sandbox)` and `getStorageProd(app)` stay as the
// direct-handle entry points (per the design rationale's
// split-factory shape). The unified `getStorage(app: PyricApp)` reads
// the brand on the `pyric/app` handle and forwards to the matching
// direct-handle factory. Storage takes optional per-backend options
// (sandbox: bucket/dbName/rules; prod: bucket) that the unified
// signature can't express without coupling — so this surface is the
// no-options entry. Callers that need options keep using the direct
// `getStorageSandbox` / `getStorageProd` factories.
export function getStorage(app: PyricApp): FirebaseStorage {
  return app[APP_TARGET] === 'sandbox'
    ? getStorageSandbox(app.sandbox)
    : getStorageProd(app.firebaseApp);
}

export { StorageError } from './errors.js';
export type { StorageErrorCode } from './errors.js';

export { ref } from './reference.js';
export type { StorageReference } from './reference.js';

export { uploadBytes, uploadString } from './upload.js';
export type { StringFormat } from './upload.js';

export { getBytes, getBlob, deleteObject } from './download.js';

export { getMetadata, updateMetadata } from './metadata.js';
export type { SettableMetadata, FullMetadata, UploadResult } from './metadata.js';

export { listAll } from './list.js';
export type { ListResult } from './list.js';

export { parseStorageRules, evaluateStorageRules } from './rules.js';
export type {
  StorageRules,
  StorageMethod,
  StorageAuth,
  StorageRequest,
  StorageResource,
  EvaluationInput,
  EvaluationResult,
} from './rules.js';

// ─── Admin / control-plane surface ───────────────────────────────────
// Firebase Storage provisioning + status. The pure-fetch `api.ts`
// layer (browser + Node compatible), the `ProjectScope`-shaped
// handlers, and the agent-tool factory.

export {
  provisionStorage,
  getStorageServiceState,
  enableStorageService,
  getDefaultLocation,
  finalizeDefaultLocation,
  listFirebaseBuckets,
  addFirebaseToBucket,
  deployStorageRules,
  getBucketCors,
  setBucketCors,
  defaultPlaygroundCors,
  StorageProvisioningError,
} from './admin/api.js';
export type {
  ServiceEnableState,
  FirebaseStorageBucket,
  ProvisionStorageOptions,
  ProvisionStorageResult,
  CorsRule,
} from './admin/api.js';

export { InspectStorageHandler, ProvisionStorageHandler } from './admin/handler.js';
export { createStorageAdminTools } from './admin/tools.js';
export type { StorageAdminToolDeps } from './admin/tools.js';
export type {
  ProvisionStorageInput,
  ProvisionStorageOutcome,
  ProvisionStorageErrorCode,
  InspectStorageResult,
} from './admin/spec.js';
