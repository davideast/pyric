---
title: "How to list and delete objects"
navLabel: "List and delete objects"
group: "pyric / storage"
section: "How-to"
order: 30
---
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

The package doesn't ship a bulk-delete helper, so compose one:
```ts
async function deleteFolder(folderRef: StorageReference): Promise<void> {
  const result = await listAll(folderRef);
  for (const item of result.items) await deleteObject(item);
  for (const sub of result.prefixes) await deleteFolder(sub);
}

await deleteFolder(ref(storage, 'sessions'));
```
On sandbox this is fast (sub-millisecond per delete). On prod it makes one HTTPS call per object, costly for large folders.

## Check pagination support

Before replacing this `listAll` recipe with Firebase's paginated `list`, query `pyric can-i-use storage/list`. That central result owns availability and points to the current evidence; this how-to does not duplicate its status.

## Gating list with rules

`listAll` enforces the rules engine at the *prefix path*. A denied prefix throws `storage/unauthorized`. Query `pyric can-i-use storage-rules/rule-kind.allow-list` before choosing between a granular `list` grant and the broader `read` umbrella.

A `read` rule scoped to an item (`match /sessions/{id} { allow read }`) does NOT grant list on the parent `/sessions`; give the folder its own rule:
```rules
match /sessions {
  allow list: if request.auth != null; // covers listAll of /sessions only
}
match /sessions/{sessionId} {
  allow get: if request.auth != null; // covers downloads of items only
}
```
Use `allow read` only when the same condition should grant both `get` and `list`. With no rules configured, `listAll` is open-by-default like every other operation.

## Where to look next

- For the reference shape and overloads, see [`StorageReference`](https://pyric.dev/docs/pyric-storage-reference-api/#storagereference) and [`ref`](https://pyric.dev/docs/pyric-storage-reference-api/#ref-1).
- For the listing result, see [`ListResult`](https://pyric.dev/docs/pyric-storage-reference-api/#listresult).
