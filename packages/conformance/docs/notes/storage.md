# `pyric/storage` — maintainer notes

Moved verbatim out of `registry/storage.ts`. Not part of the site.


## Visible gaps / open questions

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

