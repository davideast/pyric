---
title: "Error codes"
group: "pyric / storage"
section: "Reference"
order: 154
---
# Error codes

Operations through `pyric/storage` throw errors with Firebase-aligned `code` properties — `'storage/<noun>'`. Catch by code.

## Common codes

### `'storage/unauthenticated'`

The operation requires an authenticated user (rule expects `request.auth != null`) but the context's auth is `null`.

### `'storage/unauthorized'`

The operation has an authenticated user but rules denied it.

### `'storage/object-not-found'`

`getBytes`, `getBlob`, `getMetadata`, `updateMetadata` against a path with no stored object.

### `'storage/invalid-checksum'`

The uploaded payload didn't match its declared checksum. Rare in the sandbox; mostly a prod-path code.

### `'storage/quota-exceeded'`

`getBytes` / `getBlob` called with `maxDownloadSizeBytes` and the stored object is larger.

### `'storage/canceled'`

The operation was cancelled before completing. Currently sandbox doesn't generate this — the prod backend can.

### `'storage/invalid-argument'`

A function argument failed validation. Common cases: empty path, malformed string format in `uploadString`, non-string `contentType`.

## Branching
```ts
import { FirebaseError } from 'firebase/app';

try {
  await getBlob(ref(storage, 'sessions/n1'));
} catch (e) {
  if (e instanceof FirebaseError) {
    switch (e.code) {
      case 'storage/object-not-found':
        // missing
        break;
      case 'storage/unauthorized':
      case 'storage/unauthenticated':
        // denied
        break;
      default:
        throw e;
    }
  } else {
    throw e;
  }
}
```
Both backends throw `FirebaseError` for shape-consistency with the upstream `firebase/storage`. The sandbox's rule-denial errors are translated to `FirebaseError` with `storage/unauthorized` (or `storage/unauthenticated`) so consumers can write one catch.

## What's different between backends

- **Sandbox**: only emits `unauthenticated`, `unauthorized`, `object-not-found`, `quota-exceeded`, `invalid-argument`. Network-bound codes don't apply.
- **Prod**: can emit any code in the upstream `firebase/storage` set, including `canceled`, `retry-limit-exceeded`, `app-deleted`, `server-file-wrong-size`, etc.

If your error-handling code branches on a code only prod can emit, the branch will never fire in tests. That's the same situation as `metadata.fromCache` in Firestore — inert path on sandbox, real on prod.
