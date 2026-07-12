<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/storage` compatibility matrix

**85 of 103 tracked behaviors match production Firebase (83%).**

## Status legend

| Status | Meaning |
|---|---|
| ✓ | Matches Firebase |
| ⚠ | Documented difference |
| — | Not supported yet |
| ? | Not verified yet |

## `getStorageSandbox(target, options?)` / `getStorageProd(app, options?)` — initializer

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `getStorageSandbox(ctx)` returns a tagged sandbox-target handle (frozen identity) | ✓ | `unit:service.test.ts` |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `getStorageSandbox(sandbox)` wraps a bare Sandbox with an anonymous context (`auth: null`) | ✓ | `unit:service.test.ts` |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `getStorageProd(app)` returns a tagged prod-target handle | ✓ | `unit:prod-target.test.ts` |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Two `getStorageSandbox(ctx)` calls on the same context return the SAME wrapper (identity-stable) | ✓ | `unit:service.test.ts` ("returns the same handle for repeated calls on the same context") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Two `getStorageSandbox(sandbox)` calls on a bare `Sandbox` return the SAME wrapper (identity-stable) | ✓ | ST-B3 fixed: `withAuth(null)` mints a fresh context per call, so the per-context cache missed and bare-Sandbox calls returned different handles. A `Sandbox`-keyed cache makes the convenience path stable, matching the docstring. Probe: `unit:service.test.ts` ("ST-B3: returns the same handle for repeated bare-Sandbox calls"). |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Two different `SandboxContext`s on the same `Sandbox` get DIFFERENT handles but share the underlying `StorageService` (IDB) | ✓ | `unit:service.test.ts` ("shares the underlying StorageService across contexts on the same sandbox") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `options.bucket` round-trips on metadata records; v1 has a single implicit bucket but the field is preserved | ✓ | `unit:service.test.ts` ("records the bucket value on the handle") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `options.dbName` honored on the FIRST call per `Sandbox`; second-call overrides ignored | ✓ | `unit:service.test.ts` ("dbName only takes effect on the sandbox's first getStorage call") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `options.rules` parsed eagerly — malformed rules throw `SyntaxError` at config time | ✓ | `unit:rules.test.ts` (parse errors propagate from `parseStorageRules`) |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Handle dispatch by `TARGET_SYMBOL` brand — ops route to their owning target | ✓ | `unit:prod-target.test.ts` ("getStorageService throws — service is sandbox-only") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Unrecognized handle (not produced by a factory) → `TypeError` "not a FirebaseStorage handle" | ✓ | `unit:prod-target.test.ts` ("throws TypeError on objects without TARGET_SYMBOL") |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | Prod handle: `bucket` field sourced from the SDK's resolved bucket (so `gs://` overrides round-trip) | ✓ | implicit in `unit:prod-target.test.ts` |
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) |  | `getStorageSandbox(undefined)` / bare-call default-to-sandbox in playground preview | — | not yet wired — mirror of the `getFirestore` wrap (auth #4 / firestore #4) |

## `ref(storage[, path])` / `ref(parent, path)` — reference constructor

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| ref(storage[, path])` / `ref(parent, path) |  | `ref(storage)` returns the root ref — `fullPath === ''`, `name === ''`, `parent === null`, `root === self` | ✓ | `unit:reference.test.ts` ("root reference has empty fullPath, null parent, and equal root") |
| ref(storage[, path])` / `ref(parent, path) |  | `ref(storage, 'sessions/s1.json')` populates `fullPath`, `name` (last segment), `parent` (path without last segment) | ✓ | `unit:reference.test.ts` ("ref(storage, path) populates fullPath and name from the last segment") |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: leading slashes stripped (`/sessions/s1` → `sessions/s1`) | ✓ | `unit:reference.test.ts` ("normalizes leading/trailing/double slashes") |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: trailing slashes stripped | ✓ | `unit:reference.test.ts` |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: repeated internal slashes collapsed (`a//b` → `a/b`) | ✓ | `unit:reference.test.ts` |
| ref(storage[, path])` / `ref(parent, path) |  | `ref(parent, child)` joins relative to parent's `fullPath` | ✓ | `unit:reference.test.ts` ("ref(parent, child) joins relative to the parent") |
| ref(storage[, path])` / `ref(parent, path) |  | `parent` chain walks back to root (each `.parent` strips one segment until empty, then `null`) | ✓ | `unit:reference.test.ts` ("parent traversal walks back to root") |
| ref(storage[, path])` / `ref(parent, path) |  | `root` accessor returns the bucket-root ref regardless of starting depth | ✓ | `unit:reference.test.ts` |
| ref(storage[, path])` / `ref(parent, path) |  | `toString()` returns `gs://<bucket>/<fullPath>` | ✓ | `unit:reference.test.ts` ("toString returns gs://bucket/path") |
| ref(storage[, path])` / `ref(parent, path) |  | Reference identity: two `ref(s, 'a/b')` calls are equal-by-`toString` but NOT `===` (value objects, not interned) | ✓ | (implicit in `unit:reference.test.ts` parent-chain test — each `.parent` returns a fresh object) |
| ref(storage[, path])` / `ref(parent, path) |  | Prod refs proxy the underlying `firebase/storage` ref via a WeakMap; `parent` / `root` recursively wrap to keep target consistent | ✓ | `unit:prod-target.test.ts` (delegation pattern documented in `reference.ts`) |

## `uploadBytes(ref, data, metadata?)` — write blob

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| uploadBytes(ref, data, metadata?) |  | Accepts `Blob` payload; returns `UploadResult` with populated `metadata` | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") |
| uploadBytes(ref, data, metadata?) |  | Accepts `Uint8Array` payload | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array") |
| uploadBytes(ref, data, metadata?) |  | Accepts `ArrayBuffer` payload | ✓ | `unit:reference.test.ts` ("accepts an ArrayBuffer") |
| uploadBytes(ref, data, metadata?) |  | ContentType precedence: caller's `metadata.contentType` > `Blob.type` > `application/octet-stream` | ✓ | `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type" + "falls back to application/octet-stream when no type is supplied") |
| uploadBytes(ref, data, metadata?) |  | `Blob.type === ''` (no intrinsic type) falls through to `application/octet-stream`, NOT to `''` | ✓ | `unit:reference.test.ts` ("falls back to application/octet-stream when no type is supplied") |
| uploadBytes(ref, data, metadata?) |  | `customMetadata` round-trips through the upload pipeline | ✓ | `unit:reference.test.ts` ("round-trips customMetadata") + `unit:metadata.test.ts` |
| uploadBytes(ref, data, metadata?) |  | Empty `Blob.type` rewrap: when caller hint differs from `Blob.type`, the blob is re-wrapped with the caller's type (same bytes) | ✓ | implicit in `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type") |
| uploadBytes(ref, data, metadata?) |  | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws on root reference") |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.fullPath` matches the ref's `fullPath` | ✓ | `unit:reference.test.ts` |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.size` matches the input blob's byte length | ✓ | `unit:reference.test.ts` |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.bucket` matches the storage handle's bucket | ✓ | `unit:reference.test.ts` |
| uploadBytes(ref, data, metadata?) |  | Replaces any existing object at the path (overwrite, not append) | ? | sandbox semantics in `persistence.ts` use `put`; no explicit overwrite test |
| uploadBytes(ref, data, metadata?) |  | Prod: round-trips uploaded bytes through `getDownloadURL` + fetch (byte-for-byte equality) | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-bytes-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: 6-byte payload → uploadBytes → getDownloadURL → HTTPS fetch → `bytesMatch: true`, `urlIsHttps: true`, `bodyLen === payloadLen === 6`). Sandbox doesn't ship `getDownloadURL` (row #51 is `—`); the round-trip is observed prod-side only. |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.contentType` matches what the caller hinted (when set) | ✓ | `unit:reference.test.ts` + oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (`contentType: 'application/octet-stream'` round-trip against blockingfun, fb-js-sdk 12.13.0; `contentTypeMatches: true`) |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.generation` / `metageneration` are stringified counters (`'1'` after fresh upload) | ✓ | `unit:metadata.test.ts` |

## `uploadString(ref, value, format?, metadata?)` — write string-form

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| uploadString(ref, value, format?, metadata?) |  | `format='raw'` (default): UTF-8 encodes the string; `contentType` defaults to `text/plain;charset=utf-8` | ✓ | `unit:reference.test.ts` ("raw format encodes UTF-8 and defaults contentType to text/plain") |
| uploadString(ref, value, format?, metadata?) |  | `format='base64'`: decodes payload bytes from standard base64 | ✓ | `unit:reference.test.ts` ("base64 format decodes payload bytes") |
| uploadString(ref, value, format?, metadata?) |  | Sandbox: `format='base64url'` (or any unknown format) rejected with `storage/invalid-format` naming the bad format. Prod: `base64url` is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws `storage/unknown` | ⚠ | divergence, both halves oracle-locked by `packages/conformance/observations/storage/storage-uploadstring-unknown-format.json`: prod accepts `base64url` (`base64urlOk: true`) and throws `storage/unknown` for an unrecognized format — not `storage/invalid-format`. The v1 sandbox ships only `raw`/`base64`/`data_url` (matches `StringFormat`) and throws `storage/invalid-format` for anything else (ST-B3 replaced the old mis-parse-as-data_url behavior). Both sides pinned in `oracle-conformance.test.ts`; sandbox code path documented in `upload.ts`'s `decodeString`. Implementing base64url decoding is still one line in `decodeString`. |
| uploadString(ref, value, format?, metadata?) |  | `format='data_url'`: parses `data:<mime>;base64,<payload>`, infers `contentType` from prefix | ✓ | `unit:reference.test.ts` ("data_url format infers contentType from the prefix") |
| uploadString(ref, value, format?, metadata?) |  | `format='data_url'` with non-base64 payload: percent-decodes the body | ✓ | (covered by `decodeString` else-branch; no explicit test for the URL-encoded form yet) |
| uploadString(ref, value, format?, metadata?) |  | Caller's `metadata.contentType` beats data_url inference | ✓ | `unit:reference.test.ts` ("caller metadata.contentType beats data_url inference") |
| uploadString(ref, value, format?, metadata?) |  | Malformed `data_url` (no comma / doesn't start with `data:`) throws `TypeError` with "data_url format" message | ✓ | `unit:reference.test.ts` ("throws on malformed data_url") |
| uploadString(ref, value, format?, metadata?) |  | Prod: `uploadString(ref, value, 'base64')` round-trips via `getDownloadURL` + fetch | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-uploadstring-base64-roundtrip.json` (`'aGVsbG8='` → `'hello'` against blockingfun, fb-js-sdk 12.13.0; `textMatches: true`) |

## `uploadBytesResumable(ref, data, metadata?)` — resumable upload + task observers

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| uploadBytesResumable(ref, data, metadata?) |  | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` | — | not implemented in `pyric/storage` — out of scope for the v1 v1 scope per `index.ts` |
| uploadBytesResumable(ref, data, metadata?) |  | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots | — | not implemented |
| uploadBytesResumable(ref, data, metadata?) |  | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues | — | not implemented |
| uploadBytesResumable(ref, data, metadata?) |  | `task.cancel()` rejects the upload with `storage/canceled` | — | not implemented |

## `getDownloadURL(ref)` — read URL

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getDownloadURL(ref) |  | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob | — | not implemented in `pyric/storage` — out of scope per `index.ts` (no browser-renderable URL in the IDB sandbox) |
| getDownloadURL(ref) |  | Throws `storage/object-not-found` for missing objects | — | not implemented; oracle would lock prod's error shape if we ever add it |

## `getBytes(ref, maxDownloadSize?)` — read as ArrayBuffer

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getBytes(ref, maxDownloadSize?) |  | Returns the blob's contents as an `ArrayBuffer` | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array" round-trip via `getBytes`) |
| getBytes(ref, maxDownloadSize?) |  | Throws `storage/object-not-found` when no object exists at the path | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") + oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload → delete → `getDownloadURL` on the deleted ref throws `FirebaseError` with `code: 'storage/object-not-found'`) |
| getBytes(ref, maxDownloadSize?) |  | Throws when `blob.size > maxDownloadSize` with `.code` exposed | ⚠ | code-divergence (ST-B1): sandbox now throws a `StorageError` with `.code === 'storage/quota-exceeded'` (was a plain `Error` with the code only in the message). Prod's client-side cap throws `FirebaseError` with `code: 'storage/invalid-argument'` — the codes still differ, but both now expose `.code`. Probe: `unit:error-codes.test.ts` ("quota-exceeded when the blob exceeds maxDownloadSizeBytes"). Documented in `download.ts`. Aligning the code value to `invalid-argument` is deferred pending an oracle capture of prod's exact shape. |
| getBytes(ref, maxDownloadSize?) |  | Just-under-cap reads succeed and return the full byte length | ✓ | `unit:reference.test.ts` ("honors maxDownloadSizeBytes when the blob is too large") |
| getBytes(ref, maxDownloadSize?) |  | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root reads") |

## `getBlob(ref, maxDownloadSize?)` — read as Blob

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getBlob(ref, maxDownloadSize?) |  | Returns the stored bytes wrapped as a `Blob` (with `.type` from metadata) | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") |
| getBlob(ref, maxDownloadSize?) |  | Throws `storage/object-not-found` for missing paths | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") |
| getBlob(ref, maxDownloadSize?) |  | Honors `maxDownloadSize` same as `getBytes` | ✓ | (shared `fetchBlob` helper in `download.ts`) |
| getBlob(ref, maxDownloadSize?) |  | Root-ref read throws `storage/invalid-root-operation` | ✓ | shared via `guardNonRoot` in `download.ts` |

## `getStream(ref, maxDownloadSize?)` — Node-specific

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getStream(ref, maxDownloadSize?) |  | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` | — | not implemented in `pyric/storage` — browser-shaped v1 scope, no Node-stream variant |

## `deleteObject(ref)` — delete

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| deleteObject(ref) |  | Removes both the blob AND the metadata atomically (post-delete `getBlob` throws `object-not-found`) | ✓ | `unit:reference.test.ts` ("removes both blob and metadata") |
| deleteObject(ref) |  | Sandbox: no-op on missing path (does NOT throw) | ⚠ | divergence: sandbox is no-op via `persistence.ts`'s `delete`. Prod's `deleteObject` on a missing path throws `storage/object-not-found`. Oracle-locked: `packages/conformance/observations/storage/storage-delete-missing-throws.json` (`code: 'storage/object-not-found'`, `name: 'FirebaseError'` against blockingfun, fb-js-sdk 12.13.0). Both sides pinned in `oracle-conformance.test.ts`; documented in `download.ts`. |
| deleteObject(ref) |  | Throws `storage/invalid-root-operation` on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root") |
| deleteObject(ref) |  | Prod: a successful `deleteObject` followed by `getDownloadURL` on the same ref throws `storage/object-not-found` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload + delete succeed, then `getDownloadURL` throws `code: 'storage/object-not-found'`, message `"Firebase Storage: Object '…' does not exist."`, `isFirebaseError: true`) |
| deleteObject(ref) |  | Sandbox: writes-then-delete leaves no metadata (post-delete `getMetadata` throws `object-not-found`) | ✓ | follows from #63 + `getMetadata` |

## `listAll(ref)` — list all children under a ref

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| listAll(ref) |  | Returns `ListResult` with `items` (direct child files) + `prefixes` (sub-folder refs) + `nextPageToken: undefined` | ✓ | `unit:list.test.ts` |
| listAll(ref) |  | Empty bucket → both arrays empty, `nextPageToken: undefined` | ✓ | `unit:list.test.ts` ("returns empty arrays on an empty bucket") |
| listAll(ref) |  | Direct children only — does NOT recurse into grandchildren as items | ✓ | `unit:list.test.ts` ("does not recurse into grandchildren as items") |
| listAll(ref) |  | Sub-folders surface as `prefixes` and are deduplicated (many files under one folder → ONE prefix entry) | ✓ | `unit:list.test.ts` ("promotes sub-folders into prefixes (deduplicated)") |
| listAll(ref) |  | `items` sorted by path (IDB key order, lexicographic) | ✓ | `unit:list.test.ts` ("lists direct children of a folder") |
| listAll(ref) |  | `prefixes` sorted lexicographically by `fullPath` (for determinism) | ✓ | `unit:list.test.ts` (root-scan example asserts `configs` < `sessions`) |
| listAll(ref) |  | The scanned ref itself is NEVER included in `items` (even when an object exists at the exact prefix path) | ✓ | `unit:list.test.ts` ("does not include the scanned ref itself") |
| listAll(ref) |  | `listAll(ref(storage))` (root) scans the entire bucket | ✓ | `unit:list.test.ts` ("listAll on the root scans the entire bucket") |
| listAll(ref) |  | Items expose the full `StorageReference` shape (storage, bucket, name, parent) | ✓ | `unit:list.test.ts` ("items expose the StorageReference shape") |
| listAll(ref) |  | Prod: items + prefixes shape matches sandbox after `N` uploads under a directory | ✓ | oracle: `packages/conformance/observations/storage/storage-listall-shape.json` (against blockingfun, fb-js-sdk 12.13.0: 3 direct children + 1 grandchild → `items` has all 3 direct children sorted, `prefixes` has the single sub-folder, `itemCount: 3`, `prefixCount: 1`, `threeDirectChildren: true`, `oneSubPrefix: true`) |
| listAll(ref) |  | `listAll` enforces rules: `read` permission on the scanned prefix path governs list (Firebase: `read` covers download AND list), denied prefix → `storage/unauthorized` | ✓ | ST-B2 fixed: `list.ts` now calls `enforceRules` with `method: 'read'` on the listed prefix (was a silent bypass — a denied tree was still fully enumerable). With no rules configured the check is a no-op. Probe: `unit:list-rules.test.ts` ("denies an anonymous listAll of a tree the rules protect" / "allows an authed listAll"). Note: a `read` rule scoped to `match /sessions/{id}` does NOT grant list on `/sessions` — the folder needs its own read rule, matching prod; the session-archive demo ruleset adds `match /sessions { allow read }`. |

## `list(ref, options?)` — paginated list

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| list(ref, options?) |  | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain | — | not implemented in `pyric/storage` — pagination deferred per `list.ts` (the `ListResult.nextPageToken` field is kept optional so consumer code that handles pagination doesn't have to special-case the sandbox) |

## `getMetadata(ref)` / `updateMetadata(ref, metadata)` — metadata ops

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` returns the same `FullMetadata` shape `uploadBytes` produced | ✓ | `unit:metadata.test.ts` ("returns the FullMetadata uploadBytes wrote") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found for missing paths") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata(ref, patch)` replaces the listed client-settable fields wholesale (per Firebase semantics) | ✓ | `unit:metadata.test.ts` ("replaces settable fields, bumps metageneration, refreshes updated") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` bumps `metageneration` by 1 on each call | ✓ | `unit:metadata.test.ts` |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` refreshes `updated` to the call moment; `timeCreated` and `generation` stay pinned | ✓ | `unit:metadata.test.ts` |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` preserves the blob bytes (only metadata changes) | ✓ | `unit:metadata.test.ts` ("leaves the blob content untouched") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` with `undefined` field values preserves the prior value (does NOT clear it) | ⚠ | divergence: prod accepts `null` to explicitly clear a field. Sandbox doesn't model `null`-clear (per `metadata.ts` doc comment). Documented; not probe-locked. |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found when the path is missing") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | Prod: `getMetadata` after `uploadBytes` returns `contentType` and `size` matching what was uploaded | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (against blockingfun, fb-js-sdk 12.13.0: upload 128-byte payload with `contentType: 'application/octet-stream'`, getMetadata returns `metadataSize: 128`, `metadataContentType: 'application/octet-stream'`, `metadataBucket: 'blockingfun.firebasestorage.app'`, `metadataMetageneration: '1'`, `fullPathMatches: true`) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | Prod: `updateMetadata({customMetadata: {...}})` round-trips through a follow-up `getMetadata` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-update-metadata-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: post-update `getMetadata` returns the exact `customMetadata` object, `metageneration` bumps `'1'` → `'2'`, `customSurvived: true`, `metagenerationBumped: true`) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `FullMetadata.md5Hash` populated on uploads | ⚠ | divergence: sandbox does NOT compute `md5Hash`. Oracle-locked: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` confirms prod sets `md5Hash` (`hasMd5Hash: true` after a vanilla `uploadBytes`). Both sides pinned in `oracle-conformance.test.ts`. Aligning the sandbox is a one-spot fix in `upload.ts`'s `buildStoredMetadata`. |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `FullMetadata.ref` lazy population (prod populates lazily) | — | not modeled in `pyric/storage` — `metadata.ts` explicitly omits `ref` from `FullMetadata` |

## `connectStorageEmulator(storage, host, port)` — emulator hook

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| connectStorageEmulator(storage, host, port) |  | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator | — | not implemented in `pyric/storage` — the sandbox IS the local-target alternative; emulator parity is out of scope per `index.ts` |

## Op-level rules enforcement — a denied op throws `storage/unauthorized`

These are Storage SDK behaviors: how an upload / read / metadata / delete op
surfaces a rules DENY verdict. The rules-ENGINE fidelity rows
(`parseStorageRules` / `evaluateStorageRules` vs the production Rules Test
API) moved to the native `storage-rules` surface (`docs/rules/COMPAT.md`).

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| Rules enforcement |  | Op-level enforcement: `uploadBytes` against a denied path throws `storage/unauthorized` on sandbox / `storage/unauthorized` on prod, `.code` exposed on both | ✓ | ST-B1 fixed: sandbox now throws a `StorageError` (see `src/storage/errors.ts`) whose `.code === 'storage/unauthorized'` — matching prod's `FirebaseError.code`. Probe: `unit:error-codes.test.ts` ("unauthorized when rules deny the operation"). Residual divergence (documented, not a `.code` gap): the sandbox `StorageError.name` is `'StorageError'` (plain `Error` subclass, same shape as Firestore's `SandboxError`) where prod reports `name: 'FirebaseError'` / `isFirebaseError: true`, and the message wording differs (sandbox embeds the matched-rule reason chain). Oracle-locked: `packages/conformance/observations/storage/storage-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0: `code: 'storage/unauthorized'`, message `"Firebase Storage: User does not have permission to access '<path>'."`, `name: 'FirebaseError'`, `isFirebaseError: true`). |
| Rules enforcement |  | `getMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` (operation-integration section) |
| Rules enforcement |  | `updateMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` |
| Rules enforcement |  | `deleteObject` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` |

## `sandbox.*` (sandbox-only test driver)

| API | Category | Behavior | Status | Probe |
|---|---|---|---|---|
| sandbox.*` (sandbox-only test driver) |  | `getStorageService(storage)` returns the backing `StorageService` for sandbox handles (sandbox-only escape hatch for tests) | ✓ | `unit:service.test.ts` |
| sandbox.*` (sandbox-only test driver) |  | `getStorageService` on a prod-target handle throws `Error: …sandbox-only` | ✓ | `unit:prod-target.test.ts` ("throws — service is sandbox-only") |
| sandbox.*` (sandbox-only test driver) |  | `targetOf(storage)` returns the discriminated `Target` (sandbox / prod) | ✓ | `unit:service.test.ts` |
| connectStorageEmulator |  | `connectStorageEmulator(storage, host, port)` is a no-op on sandbox targets — pyric replaces the Firebase emulator, so the sandbox IS already the local emulator. Forwards to `firebase/storage`'s real `connectStorageEmulator` on prod targets | ⚠ pyric replaces the Firebase emulator; connectStorageEmulator is a no-op | `unit:connect-storage-emulator.test.ts` ("is a no-op on a sandbox handle — does not throw") |

## Intentionally not implemented

These exist in `firebase/storage` but Pyric does not implement them.

| Name | Reason |
|---|---|
| `getDownloadURL` | No browser-renderable URL in the IndexedDB sandbox. |
| `uploadBytesResumable` + `UploadTask` (pause/resume/cancel, state_changed observer) | The one-shot `uploadBytes` path is what is modeled. |
| `getStream` | Node-stream variant not modeled in the browser-shaped scope. |
| `list(ref, { maxResults, pageToken })` paginated form | `listAll` covers the current scope; pagination not modeled yet. |
| Cloud Functions Storage triggers (`onFinalize`, `onArchive`, …) | Server-side surface, not the Web SDK. |
| Image transformation URLs (Firebase Image extension) | Extension surface, not core Storage. |
| `StorageObserver` advanced shapes (progress milestones, error subclasses) | Tied to `UploadTask`; not modeled. |


## Documented differences

Where the local engine and production Firebase differ today. Each difference is pinned and tracked.

| API | Difference |
|---|---|
| uploadString(ref, value, format?, metadata?) | Sandbox: `format='base64url'` (or any unknown format) rejected with `storage/invalid-format` naming the bad format. Prod: `base64url` is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws `storage/unknown` |
| getBytes(ref, maxDownloadSize?) | Throws when `blob.size > maxDownloadSize` with `.code` exposed |
| deleteObject(ref) | Sandbox: no-op on missing path (does NOT throw) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `updateMetadata` with `undefined` field values preserves the prior value (does NOT clear it) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `FullMetadata.md5Hash` populated on uploads |
| connectStorageEmulator | `connectStorageEmulator(storage, host, port)` is a no-op on sandbox targets — pyric replaces the Firebase emulator, so the sandbox IS already the local emulator. Forwards to `firebase/storage`'s real `connectStorageEmulator` on prod targets |

## Not supported yet

Tracked but not implemented yet. Each flips to ✓ as support lands.

| API | Behavior |
|---|---|
| getStorageSandbox(target, options?)` / `getStorageProd(app, options?) | `getStorageSandbox(undefined)` / bare-call default-to-sandbox in playground preview |
| uploadBytesResumable(ref, data, metadata?) | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` |
| uploadBytesResumable(ref, data, metadata?) | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots |
| uploadBytesResumable(ref, data, metadata?) | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues |
| uploadBytesResumable(ref, data, metadata?) | `task.cancel()` rejects the upload with `storage/canceled` |
| getDownloadURL(ref) | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob |
| getDownloadURL(ref) | Throws `storage/object-not-found` for missing objects |
| getStream(ref, maxDownloadSize?) | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` |
| list(ref, options?) | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `FullMetadata.ref` lazy population (prod populates lazily) |
| connectStorageEmulator(storage, host, port) | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator |

## Not verified yet

Tracked but not yet checked against recorded production behavior.

| API | Not yet verified |
|---|---|
| uploadBytes(ref, data, metadata?) | Replaces any existing object at the path (overwrite, not append) |
