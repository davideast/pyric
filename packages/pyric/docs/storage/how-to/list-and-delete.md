# How to list and delete objects

This guide shows you how to enumerate objects under a prefix and remove them.

## List a prefix

```ts
import { ref, listAll } from 'pyric/storage';

const result = await listAll(ref(storage, 'sessions'));
console.log('Items:', result.items.map((r) => r.name));
console.log('Prefixes:', result.prefixes.map((r) => r.name));
```

`items` is direct children; `prefixes` is sub-folders (deduplicated). For `listAll(ref(storage))` (no path), the operation scans the whole bucket.

## Iterate recursively

`listAll` returns only direct children. To walk the full tree, recurse:

```ts
async function walk(folderRef: StorageReference, out: string[] = []): Promise<string[]> {
  const result = await listAll(folderRef);
  for (const item of result.items) out.push(item.fullPath);
  for (const sub of result.prefixes) await walk(sub, out);
  return out;
}

const all = await walk(ref(storage));
```

`fullPath` carries the absolute path (including the bucket prefix). Use `.name` for the leaf name only.

## Delete a single object

```ts
import { deleteObject } from 'pyric/storage';

await deleteObject(ref(storage, 'sessions/n1'));
```

Atomically removes both the blob data and the metadata. No-op on missing paths.

## Bulk delete

The package doesn't ship a bulk-delete helper — compose one:

```ts
async function deleteFolder(folderRef: StorageReference): Promise<void> {
  const result = await listAll(folderRef);
  for (const item of result.items) await deleteObject(item);
  for (const sub of result.prefixes) await deleteFolder(sub);
}

await deleteFolder(ref(storage, 'sessions'));
```

On sandbox this is fast (sub-millisecond per delete). On prod it makes one HTTPS call per object — costly for large folders.

## Pagination is deferred

`list(ref, { maxResults, pageToken })` is part of the production `firebase/storage` API but not implemented in the v1 scope. The driving use case (session archives) doesn't need pagination — every list fits in one call. The `nextPageToken: undefined` field in `ListResult` is reserved for future compatibility.

If you have a use case that needs pagination, file an issue.

## Gating list with rules

`listAll` enforces the rules engine. Firebase's `read` permission governs both download and list, evaluated against the *prefix path* — so `listAll` requires `read` on the folder you're listing. A denied prefix throws `storage/unauthorized`.

A `read` rule scoped to an item (`match /sessions/{id} { allow read }`) does NOT grant list on the parent `/sessions`; give the folder its own rule:

```
match /sessions {
  allow read: if request.auth != null; // covers listAll of /sessions
}
match /sessions/{sessionId} {
  allow read: if request.auth != null; // covers downloads of items
}
```

This mirrors production Firebase. With no rules configured, `listAll` is open-by-default like every other operation. (A distinct `allow list:` verb is deferred — the v1 scope's two-verb model folds get+list into `read`.)

## Where to look next

- For the `StorageReference` shape and the `ref(...)` overloads, see [Public API](../reference/api.md#reference-construction).
- For the `ListResult` shape, see [Public API](../reference/api.md#listing).
