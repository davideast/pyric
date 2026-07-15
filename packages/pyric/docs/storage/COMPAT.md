<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/storage` compatibility matrix

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Public surface:</strong> runtime 72.2% (13/18) <span aria-hidden="true">·</span> types 52.9% (9/17)</p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">86%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">86 of 100 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 86 conform, 6 documented divergences, 0 bugs, 8 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 86" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 8" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>86</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>6</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>8</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>0</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">Public surface measures whether exports exist. Fidelity measures whether tracked behavior matches production.</p>
</div>
[Read how the axes differ.](../conformance/SCORES.md)

> ⚠ **EXPERIMENTAL — not v1-supported.** `pyric/storage` is functional but
> work-in-progress. The v1-supported, conformance-held surface is **auth +
> firestore + rules**. The `✓` rows below are verified **sandbox-side** by unit
> probes against the documented `firebase/storage` contract — they are NOT
> wrong — but most are **not yet captured against a live prod project** (no
> `oracle:` citation), so conformance is best-effort, not guaranteed. Don't
> depend on storage parity for a production swap yet.

The single readable contract for "what this shim guarantees vs the
production `firebase/storage` SDK."

See the design rationale for the methodology (vocabulary
of conformance / oracle / matrix; how to add rows; how the runner
attributes failures).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |
| — | **Unsupported** — not implemented yet (deliberately or pending) |
| ? | **Unverified** — claim from docs that we haven't yet observed prod-side |

Probe references: `unit:<file>` means a Bun test under
`packages/pyric/test/storage/<file>`. `oracle:<name>` cites an observation
under `packages/conformance/observations/storage/<name>.json` captured by
`packages/conformance/src/run.ts` against a real Firebase project.

Target:
- **sandbox mirror** — package resolution selects `pyric/storage` before this
  module loads. The IDB-backed handle comes from `getStorage(app)` or
  `getStorageSandbox(target, options?)`; identity and rules evaluation stay
  entirely inside the sandbox. Production execution imports `firebase/storage`
  directly and never loads this mirror.

Storage differs from auth/firestore in a few load-bearing ways the
matrix has to cover:
- Two layers of payload (the blob bytes AND the metadata record).
- Content-type negotiation with three sources (caller hint, blob's
  intrinsic type, fallback to `application/octet-stream`).
- Reference identity is a value object, not an interned handle —
  `ref(s, 'a/b')` twice are equal-by-path, not `===`.
- The mirror persistence layer is IDB (with `fake-indexeddb` in tests).
  Production observations record the Firebase REST/download-URL answer key;
  the mirror never delegates to that implementation.

---

## `getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?)` — initializer

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `getStorageSandbox(ctx)` returns a tagged sandbox-target handle (frozen identity) | ✓ | `unit:service.test.ts` | 1 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `getStorageSandbox(sandbox)` wraps a bare Sandbox with an anonymous context (`auth: null`) | ✓ | `unit:service.test.ts` | 2 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `getStorage(app)` returns the sandbox handle selected by package resolution | ✓ | `entry-path:storage` runs the canonical `initializeApp` → `getStorage(app)` → `ref` → `uploadBytes` flow | 3 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | Two `getStorageSandbox(ctx)` calls on the same context return the SAME wrapper (identity-stable) | ✓ | `unit:service.test.ts` ("returns the same handle for repeated calls on the same context") | 4 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | Two `getStorageSandbox(sandbox)` calls on a bare `Sandbox` return the SAME wrapper (identity-stable) | ✓ | ST-B3 fixed: `withAuth(null)` mints a fresh context per call, so the per-context cache missed and bare-Sandbox calls returned different handles. A `Sandbox`-keyed cache makes the convenience path stable, matching the docstring. Probe: `unit:service.test.ts` ("ST-B3: returns the same handle for repeated bare-Sandbox calls"). | 4a |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | Two different `SandboxContext`s on the same `Sandbox` get DIFFERENT handles but share the underlying `StorageService` (IDB) | ✓ | `unit:service.test.ts` ("shares the underlying StorageService across contexts on the same sandbox") | 5 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `options.bucket` round-trips on metadata records; v1 has a single implicit bucket but the field is preserved | ✓ | `unit:service.test.ts` ("records the bucket value on the handle") | 6 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `options.dbName` honored on the FIRST call per `Sandbox`; second-call overrides ignored | ✓ | `unit:service.test.ts` ("dbName only takes effect on the sandbox's first getStorage call") | 7 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `options.rules` parsed eagerly — malformed rules throw `SyntaxError` at config time | ✓ | `unit:rules.test.ts` (parse errors propagate from `parseStorageRules`) | 8 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | The `TARGET_SYMBOL` brand keeps each handle bound to its owning sandbox service and identity | ✓ | `unit:service.test.ts` (distinct contexts share one service while retaining distinct handles) | 9 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | Unrecognized handle (not produced by a factory) → `TypeError` "not a FirebaseStorage handle" | ✓ | `unit:service.test.ts` ("rejects an object that was not produced by a factory") | 10 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | `getStorage(app, bucketUrl?)` accepts Firebase's bucket argument; the sandbox remains bound to its configured single bucket | ⚠ | Package resolution owns production selection. The sandbox accepts the canonical argument but does not model production multi-bucket routing; `unit:service.test.ts` pins the configured `pyric-default` bucket. | 11 |
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) |  | The served `firebase/storage` entry accepts bare `getStorage()` and returns the page's shared sandbox handle | ✓ | The canonical served entry supplies the page sandbox when the app argument is omitted; the entry-path and bundler suites execute the public package shape. | 12 |

## `ref(storage[, path])` / `ref(parent, path)` — reference constructor

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| ref(storage[, path])` / `ref(parent, path) |  | `ref(storage)` returns the root ref — `fullPath === ''`, `name === ''`, `parent === null`, `root === self` | ✓ | `unit:reference.test.ts` ("root reference has empty fullPath, null parent, and equal root") | 13 |
| ref(storage[, path])` / `ref(parent, path) |  | `ref(storage, 'sessions/s1.json')` populates `fullPath`, `name` (last segment), `parent` (path without last segment) | ✓ | `unit:reference.test.ts` ("ref(storage, path) populates fullPath and name from the last segment") | 14 |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: leading slashes stripped (`/sessions/s1` → `sessions/s1`) | ✓ | `unit:reference.test.ts` ("normalizes leading/trailing/double slashes") | 15 |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: trailing slashes stripped | ✓ | `unit:reference.test.ts` | 16 |
| ref(storage[, path])` / `ref(parent, path) |  | Path normalization: repeated internal slashes collapsed (`a//b` → `a/b`) | ✓ | `unit:reference.test.ts` | 17 |
| ref(storage[, path])` / `ref(parent, path) |  | `ref(parent, child)` joins relative to parent's `fullPath` | ✓ | `unit:reference.test.ts` ("ref(parent, child) joins relative to the parent") | 18 |
| ref(storage[, path])` / `ref(parent, path) |  | `parent` chain walks back to root (each `.parent` strips one segment until empty, then `null`) | ✓ | `unit:reference.test.ts` ("parent traversal walks back to root") | 19 |
| ref(storage[, path])` / `ref(parent, path) |  | `root` accessor returns the bucket-root ref regardless of starting depth | ✓ | `unit:reference.test.ts` | 20 |
| ref(storage[, path])` / `ref(parent, path) |  | `toString()` returns `gs://<bucket>/<fullPath>` | ✓ | `unit:reference.test.ts` ("toString returns gs://bucket/path") | 21 |
| ref(storage[, path])` / `ref(parent, path) |  | Reference identity: two `ref(s, 'a/b')` calls are equal-by-`toString` but NOT `===` (value objects, not interned) | ✓ | (implicit in `unit:reference.test.ts` parent-chain test — each `.parent` returns a fresh object) | 22 |
| ref(storage[, path])` / `ref(parent, path) |  | References are mirror-owned value objects; `parent` and `root` preserve the same storage handle and path semantics | ✓ | `unit:reference.test.ts` pins parent traversal, root identity, bucket, and path behavior through the public reference interface. | 23 |

## `uploadBytes(ref, data, metadata?)` — write blob

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| uploadBytes(ref, data, metadata?) |  | Accepts `Blob` payload; returns `UploadResult` with populated `metadata` | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") | 24 |
| uploadBytes(ref, data, metadata?) |  | Accepts `Uint8Array` payload | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array") | 25 |
| uploadBytes(ref, data, metadata?) |  | Accepts `ArrayBuffer` payload | ✓ | `unit:reference.test.ts` ("accepts an ArrayBuffer") | 26 |
| uploadBytes(ref, data, metadata?) |  | ContentType precedence: caller's `metadata.contentType` > `Blob.type` > `application/octet-stream` | ✓ | `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type" + "falls back to application/octet-stream when no type is supplied") | 27 |
| uploadBytes(ref, data, metadata?) |  | `Blob.type === ''` (no intrinsic type) falls through to `application/octet-stream`, NOT to `''` | ✓ | `unit:reference.test.ts` ("falls back to application/octet-stream when no type is supplied") | 28 |
| uploadBytes(ref, data, metadata?) |  | `customMetadata` round-trips through the upload pipeline | ✓ | `unit:reference.test.ts` ("round-trips customMetadata") + `unit:metadata.test.ts` | 29 |
| uploadBytes(ref, data, metadata?) |  | Empty `Blob.type` rewrap: when caller hint differs from `Blob.type`, the blob is re-wrapped with the caller's type (same bytes) | ✓ | implicit in `unit:reference.test.ts` ("metadata.contentType overrides the Blob's intrinsic type") | 30 |
| uploadBytes(ref, data, metadata?) |  | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws on root reference") | 31 |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.fullPath` matches the ref's `fullPath` | ✓ | `unit:reference.test.ts` | 32 |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.size` matches the input blob's byte length | ✓ | `unit:reference.test.ts` | 33 |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.bucket` matches the storage handle's bucket | ✓ | `unit:reference.test.ts` | 34 |
| uploadBytes(ref, data, metadata?) |  | Replaces any existing object at the path (overwrite, not append) | ✓ | `unit:upstream-storage-probes.test.ts` ("second uploadBytes at the same path replaces bytes and metadata") | 35 |
| uploadBytes(ref, data, metadata?) |  | Prod: round-trips uploaded bytes through `getDownloadURL` + fetch (byte-for-byte equality) | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-bytes-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: 6-byte payload → uploadBytes → getDownloadURL → HTTPS fetch → `bytesMatch: true`, `urlIsHttps: true`, `bodyLen === payloadLen === 6`). This row records the production answer key; row #51 compares the sandbox's page-local URL behavior against it. | 36 |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.contentType` matches what the caller hinted (when set) | ✓ | `unit:reference.test.ts` + oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (`contentType: 'application/octet-stream'` round-trip against blockingfun, fb-js-sdk 12.13.0; `contentTypeMatches: true`) | 37 |
| uploadBytes(ref, data, metadata?) |  | Returned `metadata.generation` / `metageneration` are stringified counters (`'1'` after fresh upload) | ✓ | `unit:metadata.test.ts` | 38 |

## `uploadString(ref, value, format?, metadata?)` — write string-form

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| uploadString(ref, value, format?, metadata?) |  | `format='raw'` (default): UTF-8 encodes the string; `contentType` defaults to `text/plain;charset=utf-8` | ✓ | `unit:reference.test.ts` ("raw format encodes UTF-8 and defaults contentType to text/plain") | 39 |
| uploadString(ref, value, format?, metadata?) |  | `format='base64'`: decodes payload bytes from standard base64 | ✓ | `unit:reference.test.ts` ("base64 format decodes payload bytes") | 40 |
| uploadString(ref, value, format?, metadata?) |  | Sandbox: `format='base64url'` (or any unknown format) rejected with `storage/invalid-format` naming the bad format. Prod: `base64url` is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws `storage/unknown` | ⚠ | divergence, both halves oracle-locked by `packages/conformance/observations/storage/storage-uploadstring-unknown-format.json`: prod accepts `base64url` (`base64urlOk: true`) and throws `storage/unknown` for an unrecognized format — not `storage/invalid-format`. The v1 sandbox ships only `raw`/`base64`/`data_url` (matches `StringFormat`) and throws `storage/invalid-format` for anything else (ST-B3 replaced the old mis-parse-as-data_url behavior). Both sides pinned in `oracle-conformance.test.ts`; sandbox code path documented in `upload.ts`'s `decodeString`. Implementing base64url decoding is still one line in `decodeString`. | 41 |
| uploadString(ref, value, format?, metadata?) |  | `format='data_url'`: parses `data:<mime>;base64,<payload>`, infers `contentType` from prefix | ✓ | `unit:reference.test.ts` ("data_url format infers contentType from the prefix") | 42 |
| uploadString(ref, value, format?, metadata?) |  | `format='data_url'` with non-base64 payload: percent-decodes the body | ✓ | `unit:upstream-storage-probes.test.ts` ("non-base64 data_url percent-decodes the body"; malformed `%%0` → `storage/invalid-format`) | 43 |
| uploadString(ref, value, format?, metadata?) |  | Caller's `metadata.contentType` beats data_url inference | ✓ | `unit:reference.test.ts` ("caller metadata.contentType beats data_url inference") | 44 |
| uploadString(ref, value, format?, metadata?) |  | Malformed `data_url` (no comma / doesn't start with `data:`) throws `TypeError` with "data_url format" message | ✓ | `unit:reference.test.ts` ("throws on malformed data_url") | 45 |
| uploadString(ref, value, format?, metadata?) |  | Prod: `uploadString(ref, value, 'base64')` round-trips via `getDownloadURL` + fetch | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-uploadstring-base64-roundtrip.json` (`'aGVsbG8='` → `'hello'` against blockingfun, fb-js-sdk 12.13.0; `textMatches: true`) | 46 |

## `uploadBytesResumable(ref, data, metadata?)` — resumable upload + task observers

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| uploadBytesResumable(ref, data, metadata?) |  | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` | — | not implemented in `pyric/storage` — out of scope for the v1 v1 scope per `index.ts` | 47 |
| uploadBytesResumable(ref, data, metadata?) |  | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots | — | not implemented | 48 |
| uploadBytesResumable(ref, data, metadata?) |  | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues | — | not implemented | 49 |
| uploadBytesResumable(ref, data, metadata?) |  | `task.cancel()` rejects the upload with `storage/canceled` | — | not implemented | 50 |

## `getDownloadURL(ref)` — read URL

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getDownloadURL(ref) |  | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob | ⚠ | Implemented with a two-sided pin. Production observation `storage-upload-bytes-roundtrip` records `urlIsHttps: true` and a byte-identical fetch. The sandbox oracle replay now calls the same public `getDownloadURL` + `fetch` path and proves byte-identical content, while explicitly asserting its URL starts with `blob:`. The client↔host integration proves SharedWorker mode creates that URL in the calling page after the rules-checked Blob crosses the port. The remaining divergence is URL identity and lifetime: the sandbox URL is a page-local snapshot, not token-signed HTTPS and not shareable outside that page. | 51 |
| getDownloadURL(ref) |  | Throws `storage/object-not-found` for missing objects | ✓ | Production observation `storage-delete-then-get-throws` records `getDownloadURL` throwing `storage/object-not-found` after deletion. The sandbox oracle replay now invokes `getDownloadURL` itself and matches that code; the public error-code suite also pins the never-existing-object case. | 52 |

## `getBytes(ref, maxDownloadSize?)` — read as ArrayBuffer

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getBytes(ref, maxDownloadSize?) |  | Returns the blob's contents as an `ArrayBuffer` | ✓ | `unit:reference.test.ts` ("accepts a Uint8Array" round-trip via `getBytes`) | 53 |
| getBytes(ref, maxDownloadSize?) |  | Throws `storage/object-not-found` when no object exists at the path | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") + oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload → delete → `getDownloadURL` on the deleted ref throws `FirebaseError` with `code: 'storage/object-not-found'`) | 54 |
| getBytes(ref, maxDownloadSize?) |  | When the object exceeds `maxDownloadSize`, returns a truncated prefix of that byte length (does not throw) | ✓ | `unit:upstream-storage-probes.test.ts` ("getBytes / getBlob return a truncated prefix when the object exceeds the cap"). Matches upstream `getBytesInternal` / `getBlobInternal` post-fetch slice (GCS may ignore Range on small files). Prior COMPAT claim that the cap throws was wrong. | 55 |
| getBytes(ref, maxDownloadSize?) |  | Just-under-cap reads succeed and return the full byte length | ✓ | `unit:upstream-storage-probes.test.ts` ("just-under-cap reads return the full object") + `unit:reference.test.ts` ("honors maxDownloadSizeBytes when the blob is too large") | 56 |
| getBytes(ref, maxDownloadSize?) |  | Throws `storage/invalid-root-operation` when called on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root reads") | 57 |

## `getBlob(ref, maxDownloadSize?)` — read as Blob

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getBlob(ref, maxDownloadSize?) |  | Returns the stored bytes wrapped as a `Blob` (with `.type` from metadata) | ✓ | `unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob") | 58 |
| getBlob(ref, maxDownloadSize?) |  | Throws `storage/object-not-found` for missing paths | ✓ | `unit:reference.test.ts` ("throws storage/object-not-found for missing paths") | 59 |
| getBlob(ref, maxDownloadSize?) |  | Honors `maxDownloadSize` same as `getBytes` | ✓ | `unit:upstream-storage-probes.test.ts` ("getBytes / getBlob return a truncated prefix when the object exceeds the cap"; shared `fetchBlob` helper in `download.ts`) | 60 |
| getBlob(ref, maxDownloadSize?) |  | Root-ref read throws `storage/invalid-root-operation` | ✓ | shared via `guardNonRoot` in `download.ts` | 61 |

## `getStream(ref, maxDownloadSize?)` — Node-specific

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getStream(ref, maxDownloadSize?) |  | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` | — | not implemented in `pyric/storage` — browser-shaped v1 scope, no Node-stream variant | 62 |

## `deleteObject(ref)` — delete

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| deleteObject(ref) |  | Removes both the blob AND the metadata atomically (post-delete `getBlob` throws `object-not-found`) | ✓ | `unit:reference.test.ts` ("removes both blob and metadata") | 63 |
| deleteObject(ref) |  | Sandbox: no-op on missing path (does NOT throw) | ⚠ | divergence: sandbox is no-op via `persistence.ts`'s `delete`. Prod's `deleteObject` on a missing path throws `storage/object-not-found`. Oracle-locked: `packages/conformance/observations/storage/storage-delete-missing-throws.json` (`code: 'storage/object-not-found'`, `name: 'FirebaseError'` against blockingfun, fb-js-sdk 12.13.0). Both sides pinned in `oracle-conformance.test.ts`; documented in `download.ts`. | 64 |
| deleteObject(ref) |  | Throws `storage/invalid-root-operation` on the root reference | ✓ | `unit:reference.test.ts` ("throws invalid-root-operation on root") | 65 |
| deleteObject(ref) |  | Prod: a successful `deleteObject` followed by `getDownloadURL` on the same ref throws `storage/object-not-found` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-delete-then-get-throws.json` (against blockingfun, fb-js-sdk 12.13.0: upload + delete succeed, then `getDownloadURL` throws `code: 'storage/object-not-found'`, message `"Firebase Storage: Object '…' does not exist."`, `isFirebaseError: true`) | 66 |
| deleteObject(ref) |  | Sandbox: writes-then-delete leaves no metadata (post-delete `getMetadata` throws `object-not-found`) | ✓ | follows from #63 + `getMetadata` | 67 |

## `listAll(ref)` — list all children under a ref

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| listAll(ref) |  | Returns `ListResult` with `items` (direct child files) + `prefixes` (sub-folder refs) + `nextPageToken: undefined` | ✓ | `unit:list.test.ts` | 68 |
| listAll(ref) |  | Empty bucket → both arrays empty, `nextPageToken: undefined` | ✓ | `unit:list.test.ts` ("returns empty arrays on an empty bucket") | 69 |
| listAll(ref) |  | Direct children only — does NOT recurse into grandchildren as items | ✓ | `unit:list.test.ts` ("does not recurse into grandchildren as items") | 70 |
| listAll(ref) |  | Sub-folders surface as `prefixes` and are deduplicated (many files under one folder → ONE prefix entry) | ✓ | `unit:list.test.ts` ("promotes sub-folders into prefixes (deduplicated)") | 71 |
| listAll(ref) |  | `items` sorted by path (IDB key order, lexicographic) | ✓ | `unit:list.test.ts` ("lists direct children of a folder") | 72 |
| listAll(ref) |  | `prefixes` sorted lexicographically by `fullPath` (for determinism) | ✓ | `unit:list.test.ts` (root-scan example asserts `configs` < `sessions`) | 73 |
| listAll(ref) |  | The scanned ref itself is NEVER included in `items` (even when an object exists at the exact prefix path) | ✓ | `unit:list.test.ts` ("does not include the scanned ref itself") | 74 |
| listAll(ref) |  | `listAll(ref(storage))` (root) scans the entire bucket | ✓ | `unit:list.test.ts` ("listAll on the root scans the entire bucket") | 75 |
| listAll(ref) |  | Items expose the full `StorageReference` shape (storage, bucket, name, parent) | ✓ | `unit:list.test.ts` ("items expose the StorageReference shape") | 76 |
| listAll(ref) |  | Prod: items + prefixes shape matches sandbox after `N` uploads under a directory | ✓ | oracle: `packages/conformance/observations/storage/storage-listall-shape.json` (against blockingfun, fb-js-sdk 12.13.0: 3 direct children + 1 grandchild → `items` has all 3 direct children sorted, `prefixes` has the single sub-folder, `itemCount: 3`, `prefixCount: 1`, `threeDirectChildren: true`, `oneSubPrefix: true`) | 77 |
| listAll(ref) |  | `listAll` enforces rules: `read` permission on the scanned prefix path governs list (Firebase: `read` covers download AND list), denied prefix → `storage/unauthorized` | ✓ | ST-B2 fixed: `list.ts` now calls `enforceRules` with `method: 'read'` on the listed prefix (was a silent bypass — a denied tree was still fully enumerable). With no rules configured the check is a no-op. Probe: `unit:list-rules.test.ts` ("denies an anonymous listAll of a tree the rules protect" / "allows an authed listAll"). Note: a `read` rule scoped to `match /sessions/{id}` does NOT grant list on `/sessions` — the folder needs its own read rule, matching prod; the session-archive demo ruleset adds `match /sessions { allow read }`. | 77a |

## `list(ref, options?)` — paginated list

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| list(ref, options?) |  | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain | — | not implemented in `pyric/storage` — pagination deferred per `list.ts` (the `ListResult.nextPageToken` field is kept optional so consumer code that handles pagination doesn't have to special-case the sandbox) | 78 |

## `getMetadata(ref)` / `updateMetadata(ref, metadata)` — metadata ops

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` returns the same `FullMetadata` shape `uploadBytes` produced | ✓ | `unit:metadata.test.ts` ("returns the FullMetadata uploadBytes wrote") | 79 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found for missing paths") | 80 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `getMetadata(ref)` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") | 81 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata(ref, patch)` replaces the listed client-settable fields wholesale (per Firebase semantics) | ✓ | `unit:metadata.test.ts` ("replaces settable fields, bumps metageneration, refreshes updated") | 82 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` bumps `metageneration` by 1 on each call | ✓ | `unit:metadata.test.ts` | 83 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` refreshes `updated` to the call moment; `timeCreated` and `generation` stay pinned | ✓ | `unit:metadata.test.ts` | 84 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` preserves the blob bytes (only metadata changes) | ✓ | `unit:metadata.test.ts` ("leaves the blob content untouched") | 85 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` with `undefined` field values preserves the prior value (does NOT clear it) | ⚠ | divergence: prod accepts `null` to explicitly clear a field. Sandbox doesn't model `null`-clear (per `metadata.ts` doc comment). Documented; not probe-locked. | 86 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` throws `storage/object-not-found` for missing paths | ✓ | `unit:metadata.test.ts` ("throws object-not-found when the path is missing") | 87 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `updateMetadata` throws `storage/invalid-root-operation` on the root | ✓ | `unit:metadata.test.ts` ("throws invalid-root-operation on the root reference") | 88 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | Prod: `getMetadata` after `uploadBytes` returns `contentType` and `size` matching what was uploaded | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` (against blockingfun, fb-js-sdk 12.13.0: upload 128-byte payload with `contentType: 'application/octet-stream'`, getMetadata returns `metadataSize: 128`, `metadataContentType: 'application/octet-stream'`, `metadataBucket: 'blockingfun.firebasestorage.app'`, `metadataMetageneration: '1'`, `fullPathMatches: true`) | 89 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | Prod: `updateMetadata({customMetadata: {...}})` round-trips through a follow-up `getMetadata` | ✓ (prod-only) | oracle: `packages/conformance/observations/storage/storage-update-metadata-roundtrip.json` (against blockingfun, fb-js-sdk 12.13.0: post-update `getMetadata` returns the exact `customMetadata` object, `metageneration` bumps `'1'` → `'2'`, `customSurvived: true`, `metagenerationBumped: true`) | 90 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `FullMetadata.md5Hash` populated on uploads | ⚠ | divergence: sandbox does NOT compute `md5Hash`. Oracle-locked: `packages/conformance/observations/storage/storage-upload-then-getmetadata.json` confirms prod sets `md5Hash` (`hasMd5Hash: true` after a vanilla `uploadBytes`). Both sides pinned in `oracle-conformance.test.ts`. Aligning the sandbox is a one-spot fix in `upload.ts`'s `buildStoredMetadata`. | 91 |
| getMetadata(ref)` / `updateMetadata(ref, metadata) |  | `FullMetadata.ref` lazy population (prod populates lazily) | — | not modeled in `pyric/storage` — `metadata.ts` explicitly omits `ref` from `FullMetadata` | 92 |

## `connectStorageEmulator(storage, host, port)` — emulator hook

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| connectStorageEmulator(storage, host, port) |  | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator | — | not implemented in `pyric/storage` — the sandbox IS the local-target alternative; emulator parity is out of scope per `index.ts` | 93 |

## Op-level rules enforcement — a denied op throws `storage/unauthorized`

These are Storage SDK behaviors: how an upload / read / metadata / delete op
surfaces a rules DENY verdict. The rules-ENGINE fidelity rows
(`parseStorageRules` / `evaluateStorageRules` vs the production Rules Test
API) moved to the native `storage-rules` surface (`docs/rules/COMPAT.md`).

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| Rules enforcement |  | Op-level enforcement: `uploadBytes` against a denied path throws `storage/unauthorized` on sandbox / `storage/unauthorized` on prod, `.code` exposed on both | ✓ | ST-B1 fixed: sandbox now throws a `StorageError` (see `src/storage/errors.ts`) whose `.code === 'storage/unauthorized'` — matching prod's `FirebaseError.code`. Probe: `unit:error-codes.test.ts` ("unauthorized when rules deny the operation"). Residual divergence (documented, not a `.code` gap): the sandbox `StorageError.name` is `'StorageError'` (plain `Error` subclass, same shape as Firestore's `SandboxError`) where prod reports `name: 'FirebaseError'` / `isFirebaseError: true`, and the message wording differs (sandbox embeds the matched-rule reason chain). Oracle-locked: `packages/conformance/observations/storage/storage-rules-denied-error-code.json` (against blockingfun, fb-js-sdk 12.13.0: `code: 'storage/unauthorized'`, message `"Firebase Storage: User does not have permission to access '<path>'."`, `name: 'FirebaseError'`, `isFirebaseError: true`). | 105 |
| Rules enforcement |  | `getMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` (operation-integration section) | 106 |
| Rules enforcement |  | `updateMetadata` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` | 107 |
| Rules enforcement |  | `deleteObject` against a denied path throws `storage/unauthorized` | ✓ | `unit:rules.test.ts` | 108 |
| Rules enforcement |  | Ordinary SDK object paths are evaluated under Firebase Storage's canonical `/b/{bucket}/o/{object}` rules namespace while metadata preserves the ordinary object path | ✓ | `unit:rules.test.ts` ("maps ordinary SDK object paths into the canonical bucket rules namespace"). Production's canonical `/b/{bucket}/o/...` namespace is independently captured on the `storage-rules` surface; this adapter mapping seam is unit-backed rather than presented as a production observation. | 109 |

## Visible gaps / open questions

- `uploadBytesResumable` (rows 47-50) — the entire upload-task + observer
  surface is unmodeled. The session-archive use case (the v1 driver)
  uses one-shot `uploadBytes`, so this stayed deferred.
- `md5Hash` (row 91) — sandbox doesn't compute it. Oracle confirms
  prod always sets it. Worth a one-row alignment if real consumer
  code reads it.
- Canonical bucket routing (row #11) — the single-bucket sandbox accepts but
  ignores `getStorage(app, bucketUrl)`. Production observations should pin the
  upstream bucket-name format before a multi-bucket sandbox is designed.

## Rows locked by the empirical oracle harness

Committed observations under `packages/conformance/observations/storage/`, captured
against the `blockingfun` project on fb-js-sdk 12.13.0:

- #36 / #51 `uploadBytes` → `getDownloadURL` → fetch round-trip — bytes
  match exactly. Production returns HTTPS; the sandbox returns a page-local
  `blob:` URL, so #51 is `diverged-documented`.
- #37 `metadata.contentType` matches caller's hint — exact round-trip.
- #46 `uploadString(_, _, 'base64')` → `getDownloadURL` → fetch text —
  decodes correctly.
- #52 / #54 / #66 `getDownloadURL` on a deleted ref — throws
  `FirebaseError` with `code: 'storage/object-not-found'` in production;
  the sandbox matches the code.
- #64 `deleteObject` on a never-uploaded path — throws
  `FirebaseError` with `code: 'storage/object-not-found'`. **Sandbox
  diverges** (no-op).
- #77 `listAll` shape — items + prefixes sort lex-order; 3 direct
  children + 1 sub-folder yields the documented shape.
- #89 `getMetadata` after `uploadBytes` — `contentType`, `size`,
  `fullPath`, `bucket`, `metageneration: '1'` all match.
- #90 `updateMetadata({customMetadata})` — round-trips through a
  follow-up `getMetadata`; `metageneration` bumps `'1'` → `'2'`.
- #91 `md5Hash` — prod sets it on every upload. **Sandbox diverges**
  (does not compute).
- #105 Op-level rules-denied — prod throws `FirebaseError` with
  `code: 'storage/unauthorized'`; message shape recorded.

## Divergences surfaced by oracle observations

- **`getDownloadURL` URL identity and lifetime** (row #51) — production
  returns token-signed HTTPS; the sandbox returns a page-local `blob:` snapshot
  that cannot be shared and lives until revoked or page unload. Both fetch the
  recorded bytes.
- **`deleteObject` on missing path** (row #64) — sandbox is a no-op
  via `persistence.ts`'s `delete`; prod throws
  `storage/object-not-found`. Fix candidate: detect-and-throw in
  `download.ts`'s `deleteObject` sandbox path.
- **`md5Hash` not populated by sandbox** (row #91) — prod always sets
  it. Fix candidate: compute hex md5 in `upload.ts`'s
  `buildStoredMetadata` (Node `crypto` or Web Crypto in browser).
- **`uploadString` format handling** (row #41) — prod accepts
  `base64url` and throws `storage/unknown` for a genuinely-unknown
  format; the sandbox throws `storage/invalid-format` for both. Fix
  candidates: decode `base64url` in `decodeString` (one line) and
  align the unknown-format error code.
- **`null`-clear semantics in `updateMetadata`** (row #86) — sandbox
  preserves prior values when patch fields are `undefined`, but
  doesn't model `null`-clear at all. Documented in `metadata.ts`.

---

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/storage` but the sandbox refuses to import or
model them. They're either out-of-scope per the v1 scope or pending
a follow-up driver decision.

| Name | Reason |
|---|---|
| `uploadBytesResumable` + `UploadTask` (pause/resume/cancel, state_changed observer) | Out of scope — session-archive use case is one-shot upload-bytes only |
| `getStream` | Node-stream variant not modeled in the browser-shaped v1 scope |
| `list(ref, { maxResults, pageToken })` paginated form | Deferred — `listAll` covers the v1 scope scenarios; pagination needs a stable pageToken shape |
| Cloud Functions Storage triggers (`onFinalize`, `onArchive`, …) | Server-side surface — not the Web SDK |
| Image transformation URLs (Firebase Image extension) | Extension surface, not core Storage |
| `StorageObserver` advanced shapes (progress milestones, error subclasses) | Tied to `UploadTask`; out of scope until resumable ships |


## Current gaps

### Documented divergences

Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.

| API | Behavior |
|---|---|
| getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?) | `getStorage(app, bucketUrl?)` accepts Firebase's bucket argument; the sandbox remains bound to its configured single bucket |
| uploadString(ref, value, format?, metadata?) | Sandbox: `format='base64url'` (or any unknown format) rejected with `storage/invalid-format` naming the bad format. Prod: `base64url` is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws `storage/unknown` |
| getDownloadURL(ref) | Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob |
| deleteObject(ref) | Sandbox: no-op on missing path (does NOT throw) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `updateMetadata` with `undefined` field values preserves the prior value (does NOT clear it) |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `FullMetadata.md5Hash` populated on uploads |

### Unsupported

Tracked behavior that is not implemented in the current contract.

| API | Behavior |
|---|---|
| uploadBytesResumable(ref, data, metadata?) | Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()` |
| uploadBytesResumable(ref, data, metadata?) | `task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots |
| uploadBytesResumable(ref, data, metadata?) | `task.pause()` flips `state` to `'paused'`; `task.resume()` continues |
| uploadBytesResumable(ref, data, metadata?) | `task.cancel()` rejects the upload with `storage/canceled` |
| getStream(ref, maxDownloadSize?) | Exported by `firebase/storage` (Node entry only); returns a Node `Readable` |
| list(ref, options?) | Exported by `firebase/storage`; accepts `{ maxResults, pageToken }`, returns a `ListResult` with `nextPageToken` set when more pages remain |
| getMetadata(ref)` / `updateMetadata(ref, metadata) | `FullMetadata.ref` lazy population (prod populates lazily) |
| connectStorageEmulator(storage, host, port) | Exported by `firebase/storage`; reroutes a `FirebaseStorage` handle to a local emulator |
