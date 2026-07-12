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

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | `getStorageSandbox(ctx)` returns a tagged sandbox-target handle (frozen identity) | ✓ | `unit:service.test.ts` |
| 2 | `getStorageSandbox(sandbox)` wraps a bare Sandbox with an anonymous context (`auth: null`) | ✓ | `unit:service.test.ts` |
| 3 | `getStorageProd(app)` returns a tagged prod-target handle | ✓ | `unit:prod-target.test.ts` |
| 4 | Two `getStorageSandbox(ctx)` calls on the same context return the SAME wrapper (identity-stable) | ✓ | `unit:service.test.ts` ("returns the same handle for repeated calls on the same context") |
| 4a | Two `getStorageSandbox(sandbox)` calls on a bare `Sandbox` return the SAME wrapper (identity-stable) | ✓ | ST-B3 fixed: `withAuth(null)` mints a fresh context per call, so the per-context cache missed and bare-Sandbox calls returned different handles. A `Sandbox`-keyed cache makes the convenience path stable, matching the docstring. Probe: `unit:service.test.ts` ("ST-B3: returns the same handle for repeated bare-Sandbox calls"). |
| 5 | Two different `SandboxContext`s on the same `Sandbox` get DIFFERENT handles but share the underlying `StorageService` (IDB) | ✓ | `unit:service.test.ts` ("shares the underlying StorageService across contexts on the same sandbox") |
| 6 | `options.bucket` round-trips on metadata records; v1 has a single implicit bucket but the field is preserved | ✓ | `unit:service.test.ts` ("records the bucket value on the handle") |
| 7 | `options.dbName` honored on the FIRST call per `Sandbox`; second-call overrides ignored | ✓ | `unit:service.test.ts` ("dbName only takes effect on the sandbox's first getStorage call") |
| 8 | `options.rules` parsed eagerly — malformed rules throw `SyntaxError` at config time | ✓ | `unit:rules.test.ts` (parse errors propagate from `parseStorageRules`) |
| 9 | Handle dispatch by `TARGET_SYMBOL` brand — ops route to their owning target | ✓ | `unit:prod-target.test.ts` ("getStorageService throws — service is sandbox-only") |
| 10 | Unrecognized handle (not produced by a factory) → `TypeError` "not a FirebaseStorage handle" | ✓ | `unit:prod-target.test.ts` ("throws TypeError on objects without TARGET_SYMBOL") |
| 11 | Prod handle: `bucket` field sourced from the SDK's resolved bucket (so `gs://` overrides round-trip) | ✓ | implicit in `unit:prod-target.test.ts` |
| 12 | `getStorageSandbox(undefined)` / bare-call default-to-sandbox in playground preview | — | not yet wired — mirror of the `getFirestore` wrap (auth #4 / firestore #4) |

## `ref(storage[, path])` / `ref(parent, path)` — reference constructor

| # | Behavior | Status | Probe |
|---|---|---|---|
| 13 | `ref(storage)` returns the root ref — `fullPath === ''`, `name === ''`, `parent === null`, `root === self` | ✓ | `unit:reference.test.ts` ("root reference has empty fullPath, null parent, and equal root") |
| 14 | `ref(storage, 'sessions/s1.json')` populates `fullPath`, `name` (last segment), `parent` (path without last segment) | ✓ | `unit:reference.test.ts` ("ref(storage, path) populates fullPath and name from the last segment") |
| 15 | Path normalization: leading slashes stripped (`/sessions/s1` → `sessions/s1`) | ✓ | `unit:reference.test.ts` ("normalizes leading/trailing/double slashes") |
| 16 | Path normalization: trailing slashes stripped | ✓ | `unit:reference.test.ts` |
| 17 | Path normalization: repeated internal slashes collapsed (`a//b` → `a/b`) | ✓ | `unit:reference.test.ts` |
| 18 | `ref(parent, child)` joins relative to parent's `fullPath` | ✓ | `unit:reference.test.ts` ("ref(parent, child) joins relative to the parent") |
| 19 | `parent` chain walks back to root (each `.parent` strips one segment until empty, then `null`) | ✓ | `unit:reference.test.ts` ("parent traversal walks back to root") |
| 20 | `root` accessor returns the bucket-root ref regardless of starting depth | ✓ | `unit:reference.test.ts` |
| 21 | `toString()` returns `gs://<bucket>/<fullPath>` | ✓ | `unit:reference.test.ts` ("toString returns gs://bucket/path") |
| 22 | Reference identity: two `ref(s, 'a/b')` calls are equal-by-`toString` but NOT `===` (value objects, not interned) | ✓ | (implicit in `unit:reference.test.ts` parent-chain test — each `.parent` returns a fresh object) |
| 23 | Prod refs proxy the underlying `firebase/storage` ref via a WeakMap; `parent` / `root` recursively wrap to keep target consistent | ✓ | `unit:prod-target.test.ts` (delegation pattern documented in `reference.ts`) |

## `uploadBytes(ref, data, metadata?)` — write blob

| # | Behavior | Status | Probe |
|---|---|---|---|
| 24 | Accepts `Blob` payload; returns `UploadResult` with populated `metadata` | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") |
| 25 | Accepts `Uint8Array` payload | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array") |
| 26 | Accepts `ArrayBuffer` payload | ✓ | `unit:reference.test.ts` ("accepts an ArrayBuffer") |
| 27 | ContentType precedence: caller's `metadata.contentType` > `Blob.type` > `application/octet-stream` | ✓ | `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type" + "falls back to application/octet-stream when no type is supplied") |
| 28 | `Blob.type === ''` (no intrinsic type) falls through to `application/octet-stream`, NOT to `''` | ✓ | `unit:reference.test.ts` ("falls back to application/octet-stream when no type is supplied") |
| 29 | `customMetadata` round-trips through the upload pipeline | ✓ | `unit:reference.test.ts` ("round-trips customMetadata") + `unit:metadata.test.ts` |
| 30 | Empty `Blob.type` rewrap: when caller hint differs from `Blob.type`, the blob is re-wrapped with the caller's type (same bytes) | ✓ | implicit in `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type") |
| 31 | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws on root reference") |
| 32 | Returned `metadata.fullPath` matches the ref's `fullPath` | ✓ | `unit:reference.test.ts` |
| 33 | Returned `metadata.size` matches the input blob's byte length | ✓ | `unit:reference.test.ts` |
| 34 | Returned `metadata.bucket` matches the storage handle's bucket | ✓ | `unit:reference.test.ts` |
| 35 | Replaces any existing object at the path (overwrite, not append) | ? | sandbox semantics in `persistence.ts` use `put`; no explicit overwrite test |
| 36 | Prod: round-trips uploaded bytes through `getDownloadURL` + fetch (byte-for-byte equality) | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-bytes-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: 6-byte payload → uploadBytes → getDownloadURL → HTTPS fetch → `bytesMatch: true`, `urlIsHttps: true`, `bodyLen === payloadLen === 6`). Sandbox doesn't ship `getDownloadURL` (row #51 is `—`); the round-trip is observed prod-side only. |
| 37 | Returned `metadata.contentType` matches what the caller hinted (when set) | ✓ | `unit:reference.test.ts` + oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (`contentType: 'application/octet-stream'` round-trip against blockingfun, fb-js-sdk 12.13.0; `contentTypeMatches: true`) |
| 38 | Returned `metadata.generation` / `metageneration` are stringified counters (`'1'` after fresh upload) | ✓ | `unit:metadata.test.ts` |

## `uploadString(ref, value, format?, metadata?)` — write string-form

| # | Behavior | Status | Probe |
|---|---|---|---|
| 39 | `format='raw'` (default): UTF-8 encodes the string; `contentType` defaults to `text/plain;charset=utf-8` | ✓ | `unit:reference.test.ts` ("raw format encodes UTF-8 and defaults contentType to text/plain") |
| 40 | `format='base64'`: decodes payload bytes from standard base64 | ✓ | `unit:reference.test.ts` ("base64 format decodes payload bytes") |
| 41 | Sandbox: `format='base64url'` (or any unknown format) rejected with `storage/invalid-format` naming the bad format. Prod: `base64url` is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws `storage/unknown` | ⚠ | divergence, both halves oracle-locked by `packages/conformance/observations/storage/storage-uploadstring-unknown-format.json`: prod accepts `base64url` (`base64urlOk: true`) and throws `storage/unknown` for an unrecognized format — not `storage/invalid-format`. The v1 sandbox ships only `raw`/`base64`/`data_url` (matches `StringFormat`) and throws `storage/invalid-format` for anything else (ST-B3 replaced the old mis-parse-as-data_url behavior). Both sides pinned in `oracle-conformance.test.ts`; sandbox code path documented in `upload.ts`'s `decodeString`. Implementing base64url decoding is still one line in `decodeString`. |
| 42 | `format='data_url'`: parses `data:<mime>;base64,<payload>`, infers `contentType` from prefix | ✓ | `unit:reference.test.ts` ("data_url format infers contentType from the prefix") |
| 43 | `format='data_url'` with non-base64 payload: percent-decodes the body | ✓ | (covered by `decodeString` else-branch; no explicit test for the URL-encoded form yet) |
| 44 | Caller's `metadata.contentType` beats data_url inference | ✓ | `unit:reference.test.ts` ("caller metadata.contentType beats data_url inference") |
| 45 | Malformed `data_url` (no comma / doesn't start with `data:`) throws `TypeError` with "data_url format" message | ✓ | `unit:reference.test.ts` ("throws on malformed data_url") |
| 46 | Prod: `uploadString(ref, value, 'base64')` round-trips via `getDownloadURL` + fetch | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-uploadstring-base64-roundtrip.json` (`'aGVsbG8='` → `'hello'` against blockingfun, fb-js-sdk 12.13.0; `textMatches: true`) |

## `uploadBytesResumable(ref, data, metadata?)` — resumable upload + task observers

| # | Behavior | Status | Probe |
|---|---|---|---|
| 47 | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` | — | not implemented in `pyric/storage` — out of scope for the v1 v1 scope per `index.ts` |
| 48 | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots | — | not implemented |
| 49 | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues | — | not implemented |
| 50 | `task.cancel()` rejects the upload with `storage/canceled` | — | not implemented |

## `getDownloadURL(ref)` — read URL

| # | Behavior | Status | Probe |
|---|---|---|---|
| 51 | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob | — | not implemented in `pyric/storage` — out of scope per `index.ts` (no browser-renderable URL in the IDB sandbox) |
| 52 | Throws `storage/object-not-found` for missing objects | — | not implemented; oracle would lock prod's error shape if we ever add it |

## `getBytes(ref, maxDownloadSize?)` — read as ArrayBuffer

| # | Behavior | Status | Probe |
|---|---|---|---|
| 53 | Returns the blob's contents as an `ArrayBuffer` | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array" round-trip via `getBytes`) |
| 54 | Throws `storage/object-not-found` when no object exists at the path | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") + oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload → delete → `getDownloadURL` on the deleted ref throws `FirebaseError` with `code: 'storage/object-not-found'`) |
| 55 | Throws when `blob.size > maxDownloadSize` with `.code` exposed | ⚠ | code-divergence (ST-B1): sandbox now throws a `StorageError` with `.code === 'storage/quota-exceeded'` (was a plain `Error` with the code only in the message). Prod's client-side cap throws `FirebaseError` with `code: 'storage/invalid-argument'` — the codes still differ, but both now expose `.code`. Probe: `unit:error-codes.test.ts` ("quota-exceeded when the blob exceeds maxDownloadSizeBytes"). Documented in `download.ts`. Aligning the code value to `invalid-argument` is deferred pending an oracle capture of prod's exact shape. |
| 56 | Just-under-cap reads succeed and return the full byte length | ✓ | `unit:reference.test.ts` ("honors maxDownloadSizeBytes when the blob is too large") |
| 57 | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root reads") |

## `getBlob(ref, maxDownloadSize?)` — read as Blob

| # | Behavior | Status | Probe |
|---|---|---|---|
| 58 | Returns the stored bytes wrapped as a `Blob` (with `.type` from metadata) | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") |
| 59 | Throws `storage/object-not-found` for missing paths | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") |
| 60 | Honors `maxDownloadSize` same as `getBytes` | ✓ | (shared `fetchBlob` helper in `download.ts`) |
| 61 | Root-ref read throws `storage/invalid-root-operation` | ✓ | shared via `guardNonRoot` in `download.ts` |

## `getStream(ref, maxDownloadSize?)` — Node-specific

| # | Behavior | Status | Probe |
|---|---|---|---|
| 62 | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` | — | not implemented in `pyric/storage` — browser-shaped v1 scope, no Node-stream variant |

## `deleteObject(ref)` — delete

| # | Behavior | Status | Probe |
|---|---|---|---|
| 63 | Removes both the blob AND the metadata atomically (post-delete `getBlob` throws `object-not-found`) | ✓ | `unit:reference.test.ts` ("removes both blob and metadata") |
| 64 | Sandbox: no-op on missing path (does NOT throw) | ⚠ | divergence: sandbox is no-op via `persistence.ts`'s `delete`. Prod's `deleteObject` on a missing path throws `storage/object-not-found`. Oracle-locked: `packages/conformance/observations/storage/storage-delete-missing-throws.json` (`code: 'storage/object-not-found'`, `name: 'FirebaseError'` against blockingfun, fb-js-sdk 12.13.0). Both sides pinned in `oracle-conformance.test.ts`; documented in `download.ts`. |
| 65 | Throws `storage/invalid-root-operation` on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root") |
| 66 | Prod: a successful `deleteObject` followed by `getDownloadURL` on the same ref throws `storage/object-not-found` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload + delete succeed, then `getDownloadURL` throws `code: 'storage/object-not-found'`, message `"Firebase Storage: Object '…' does not exist."`, `isFirebaseError: true`) |
| 67 | Sandbox: writes-then-delete leaves no metadata (post-delete `getMetadata` throws `object-not-found`) | ✓ | follows from #63 + `getMetadata` |

## `listAll(ref)` — list all children under a ref

| # | Behavior | Status | Probe |
|---|---|---|---|
| 68 | Returns `ListResult` with `items` (direct child files) + `prefixes` (sub-folder refs) + `nextPageToken: undefined` | ✓ | `unit:list.test.ts` |
| 69 | Empty bucket → both arrays empty, `nextPageToken: undefined` | ✓ | `unit:list.test.ts` ("returns empty arrays on an empty bucket") |
| 70 | Direct children only — does NOT recurse into grandchildren as items | ✓ | `unit:list.test.ts` ("does not recurse into grandchildren as items") |
| 71 | Sub-folders surface as `prefixes` and are deduplicated (many files under one folder → ONE prefix entry) | ✓ | `unit:list.test.ts` ("promotes sub-folders into prefixes (deduplicated)") |
| 72 | `items` sorted by path (IDB key order, lexicographic) | ✓ | `unit:list.test.ts` ("lists direct children of a folder") |
| 73 | `prefixes` sorted lexicographically by `fullPath` (for determinism) | ✓ | `unit:list.test.ts` (root-scan example asserts `configs` < `sessions`) |
| 74 | The scanned ref itself is NEVER included in `items` (even when an object exists at the exact prefix path) | ✓ | `unit:list.test.ts` ("does not include the scanned ref itself") |
| 75 | `listAll(ref(storage))` (root) scans the entire bucket | ✓ | `unit:list.test.ts` ("listAll on the root scans the entire bucket") |
| 76 | Items expose the full `StorageReference` shape (storage, bucket, name, parent) | ✓ | `unit:list.test.ts` ("items expose the StorageReference shape") |
| 77 | Prod: items + prefixes shape matches sandbox after `N` uploads under a directory | ✓ | oracle: `packages/conformance/observations/storage/storage-listall-shape.json` (against blockingfun, fb-js-sdk 12.13.0: 3 direct children + 1 grandchild → `items` has all 3 direct children sorted, `prefixes` has the single sub-folder, `itemCount: 3`, `prefixCount: 1`, `threeDirectChildren: true`, `oneSubPrefix: true`) |
| 77a | `listAll` enforces rules: `read` permission on the scanned prefix path governs list (Firebase: `read` covers download AND list), denied prefix → `storage/unauthorized` | ✓ | ST-B2 fixed: `list.ts` now calls `enforceRules` with `method: 'read'` on the listed prefix (was a silent bypass — a denied tree was still fully enumerable). With no rules configured the check is a no-op. Probe: `unit:list-rules.test.ts` ("denies an anonymous listAll of a tree the rules protect" / "allows an authed listAll"). Note: a `read` rule scoped to `match /sessions/{id}` does NOT grant list on `/sessions` — the folder needs its own read rule, matching prod; the session-archive demo ruleset adds `match /sessions { allow read }`. |

## `list(ref, options?)` — paginated list

| # | Behavior | Status | Probe |
|---|---|---|---|
| 78 | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain | — | not implemented in `pyric/storage` — pagination deferred per `list.ts` (the `ListResult.nextPageToken` field is kept optional so consumer code that handles pagination doesn't have to special-case the sandbox) |

## `getMetadata(ref)` / `updateMetadata(ref, metadata)` — metadata ops

| # | Behavior | Status | Probe |
|---|---|---|---|
| 79 | `getMetadata(ref)` returns the same `FullMetadata` shape `uploadBytes` produced | ✓ | `unit:metadata.test.ts` ("returns the FullMetadata uploadBytes wrote") |
| 80 | `getMetadata(ref)` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found for missing paths") |
| 81 | `getMetadata(ref)` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") |
| 82 | `updateMetadata(ref, patch)` replaces the listed client-settable fields wholesale (per Firebase semantics) | ✓ | `unit:metadata.test.ts` ("replaces settable fields, bumps metageneration, refreshes updated") |
| 83 | `updateMetadata` bumps `metageneration` by 1 on each call | ✓ | `unit:metadata.test.ts` |
| 84 | `updateMetadata` refreshes `updated` to the call moment; `timeCreated` and `generation` stay pinned | ✓ | `unit:metadata.test.ts` |
| 85 | `updateMetadata` preserves the blob bytes (only metadata changes) | ✓ | `unit:metadata.test.ts` ("leaves the blob content untouched") |
| 86 | `updateMetadata` with `undefined` field values preserves the prior value (does NOT clear it) | ⚠ | divergence: prod accepts `null` to explicitly clear a field. Sandbox doesn't model `null`-clear (per `metadata.ts` doc comment). Documented; not probe-locked. |
| 87 | `updateMetadata` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found when the path is missing") |
| 88 | `updateMetadata` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") |
| 89 | Prod: `getMetadata` after `uploadBytes` returns `contentType` and `size` matching what was uploaded | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (against blockingfun, fb-js-sdk 12.13.0: upload 128-byte payload with `contentType: 'application/octet-stream'`, getMetadata returns `metadataSize: 128`, `metadataContentType: 'application/octet-stream'`, `metadataBucket: 'blockingfun.firebasestorage.app'`, `metadataMetageneration: '1'`, `fullPathMatches: true`) |
| 90 | Prod: `updateMetadata({customMetadata: {...}})` round-trips through a follow-up `getMetadata` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-update-metadata-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: post-update `getMetadata` returns the exact `customMetadata` object, `metageneration` bumps `'1'` → `'2'`, `customSurvived: true`, `metagenerationBumped: true`) |
| 91 | `FullMetadata.md5Hash` populated on uploads | ⚠ | divergence: sandbox does NOT compute `md5Hash`. Oracle-locked: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` confirms prod sets `md5Hash` (`hasMd5Hash: true` after a vanilla `uploadBytes`). Both sides pinned in `oracle-conformance.test.ts`. Aligning the sandbox is a one-spot fix in `upload.ts`'s `buildStoredMetadata`. |
| 92 | `FullMetadata.ref` lazy population (prod populates lazily) | — | not modeled in `pyric/storage` — `metadata.ts` explicitly omits `ref` from `FullMetadata` |

## `connectStorageEmulator(storage, host, port)` — emulator hook

| # | Behavior | Status | Probe |
|---|---|---|---|
| 93 | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator | — | not implemented in `pyric/storage` — the sandbox IS the local-target alternative; emulator parity is out of scope per `index.ts` |

## Op-level rules enforcement — a denied op throws `storage/unauthorized`

These are Storage SDK behaviors: how an upload / read / metadata / delete op
surfaces a rules DENY verdict. The rules-ENGINE fidelity rows
(`parseStorageRules` / `evaluateStorageRules` vs the production Rules Test
API) moved to the native `storage-rules` surface (`docs/rules/COMPAT.md`).

| # | Behavior | Status | Probe |
|---|---|---|---|
| 105 | Op-level enforcement: `uploadBytes` against a denied path throws `storage/unauthorized` on sandbox / `storage/unauthorized` on prod, `.code` exposed on both | ✓ | ST-B1 fixed: sandbox now throws a `StorageError` (see `src/storage/errors.ts`) whose `.code === 'storage/unauthorized'` — matching prod's `FirebaseError.code`. Probe: `unit:error-codes.test.ts` ("unauthorized when rules deny the operation"). Residual divergence (documented, not a `.code` gap): the sandbox `StorageError.name` is `'StorageError'` (plain `Error` subclass, same shape as Firestore's `SandboxError`) where prod reports `name: 'FirebaseError'` / `isFirebaseError: true`, and the message wording differs (sandbox embeds the matched-rule reason chain). Oracle-locked: `packages/conformance/observations/storage/storage-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0: `code: 'storage/unauthorized'`, message `"Firebase Storage: User does not have permission to access '<path>'."`, `name: 'FirebaseError'`, `isFirebaseError: true`). |
| 106 | `getMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` (operation-integration section) |
| 107 | `updateMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` |
| 108 | `deleteObject` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` |

## `sandbox.*` (sandbox-only test driver)

| # | Behavior | Status | Probe |
|---|---|---|---|
| 109 | `getStorageService(storage)` returns the backing `StorageService` for sandbox handles (sandbox-only escape hatch for tests) | ✓ | `unit:service.test.ts` |
| 110 | `getStorageService` on a prod-target handle throws `Error: …sandbox-only` | ✓ | `unit:prod-target.test.ts` ("throws — service is sandbox-only") |
| 111 | `targetOf(storage)` returns the discriminated `Target` (sandbox / prod) | ✓ | `unit:service.test.ts` |
| 117 | `connectStorageEmulator(storage, host, port)` is a no-op on sandbox targets — pyric replaces the Firebase emulator, so the sandbox IS already the local emulator. Forwards to `firebase/storage`'s real `connectStorageEmulator` on prod targets | ⚠ pyric replaces the Firebase emulator; connectStorageEmulator is a no-op | `unit:connect-storage-emulator.test.ts` ("is a no-op on a sandbox handle — does not throw") |

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


## Not supported yet

Tracked but not implemented yet. Each flips to ✓ as support lands.

| # | Behavior |
|---|---|
| 12 | `getStorageSandbox(undefined)` / bare-call default-to-sandbox in playground preview |
| 47 | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` |
| 48 | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots |
| 49 | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues |
| 50 | `task.cancel()` rejects the upload with `storage/canceled` |
| 51 | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob |
| 52 | Throws `storage/object-not-found` for missing objects |
| 62 | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` |
| 78 | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain |
| 92 | `FullMetadata.ref` lazy population (prod populates lazily) |
| 93 | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator |
