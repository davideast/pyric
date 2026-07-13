---
title: "StorageOptions"
group: "pyric / storage"
section: "Reference"
order: 15010
---
# `StorageOptions`

The options bag for `getStorageSandbox(target, options?)`.
```ts
interface StorageOptions {
  bucket?: string;
  dbName?: string;
  rules?: string;
}
```
## `bucket`

The bucket identifier recorded in `metadata.bucket` on upload. v1 has a single implicit bucket: passing different values doesn't isolate data, but it round-trips through metadata.

Default: a stable internal value (`pyric-default` historically).

When real multi-bucket support lands, this option will partition data. For the v1 scope, treat it as a label, not a partition.

## `dbName`

The IndexedDB database name. Tests pass a per-case unique name so state doesn't leak between runs:
```ts
const storage = getStorageSandbox(sandbox.withAuth(null), {
  dbName: `test-${crypto.randomUUID()}`,
});
```
Only takes effect on the **first** `getStorageSandbox` call per `Sandbox`. Subsequent calls return the cached handle bound to the original `dbName`. To change the IndexedDB name, build a new sandbox.

## `rules`

Storage rules source, parsed eagerly at config time. Malformed sources throw a `SyntaxError` from the parser before the handle is returned. Fail fast.
```ts
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
  rules: `service firebase.storage {
    match /b/{bucket}/o {
      match /sessions/{id} {
        allow write: if request.auth != null
                     && request.resource.size < 10 * 1024 * 1024;
        allow read: if request.auth != null;
      }
    }
  }`,
});
```
Only takes effect on the **first** call per `Sandbox`. Subsequent calls return the cached handle with the original rules. To change rules, build a new sandbox.

If `rules` is omitted, the storage handle accepts every operation (anonymous and authenticated alike). Useful for non-rule-related tests but explicitly insecure. Set rules whenever the test is about access control.

See [Storage rules subset](../pyric-storage-reference-rules-subset/) for the supported grammar.

## What is *not* a `StorageOptions` field

- **Per-call auth overrides**. The handle's auth comes from the `SandboxContext` passed to `getStorageSandbox`. To act as a different user, derive a new context.
- **Per-call bucket overrides**. The bucket is fixed at handle construction. If you need to test multi-bucket scenarios, build multiple handles.
- **Persistence settings**. The sandbox uses IndexedDB; the choice is internal.
