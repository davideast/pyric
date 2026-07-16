---
title: "Error codes"
group: "pyric / storage"
section: "Reference"
order: 70
---
# Error codes

Operations through `pyric/storage` throw errors with Firebase-aligned `code` properties, `'storage/<noun>'`. Catch by code.

## Common codes

### `'storage/unauthenticated'`

The operation requires an authenticated user (rule expects `request.auth != null`) but the context's auth is `null`.

### `'storage/unauthorized'`

The operation has an authenticated user but rules denied it.

### `'storage/object-not-found'`

`getBytes`, `getBlob`, `getMetadata`, `updateMetadata` against a path with no stored object.

### `'storage/quota-exceeded'`

Reserved on the `StorageErrorCode` union for upstream parity. The sandbox does **not** raise it for `maxDownloadSizeBytes` — that path truncates like production. Bucket-level quota is not modeled.

### `'storage/invalid-argument'`

A function argument failed validation. Common cases: empty path, malformed string format in `uploadString`, non-string `contentType`.

## Branching

```ts
try {
  await getBlob(ref(storage, 'sessions/n1'));
} catch (e) {
  if (e && typeof e === 'object' && 'code' in e) {
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

The sandbox throws `StorageError`, an `Error` subclass whose `.code` carries the Firebase-shaped value. Production code imports `firebase/storage` directly and receives Firebase's own error class; branching on `.code` works in both environments without coupling application code to either constructor.

## What the sandbox does not emit

The sandbox emits only `unauthenticated`, `unauthorized`, `object-not-found`, `quota-exceeded`, `invalid-root-operation`, `invalid-format`, and `invalid-argument`. Network-bound codes such as `canceled`, `retry-limit-exceeded`, `app-deleted`, and `server-file-wrong-size` do not apply.

If application error handling branches on a network-only code, that branch will not fire while the package swap is active. Exercise it in a production-integration test against Firebase.
