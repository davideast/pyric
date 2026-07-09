---
title: "Upload and download a session archive"
navLabel: "Upload and download"
group: "pyric / storage"
section: "Tutorials"
order: 116
---
# Upload and download a session archive

In this tutorial you will build the session-archive flow `pyric/storage` was designed for: upload a JSON blob, list the archive, download an entry, enforce rules so anonymous callers can't poison the bucket.

By the end you'll have seen every major piece of the package in action.

## Before you start
```bash
mkdir storage-tutorial && cd storage-tutorial
bun init -y
bun add pyric/sandbox pyric/storage
```
## Step 1 — Set up the sandbox + storage

Create `archive.ts`:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, getBlob, listAll, deleteObject } from 'pyric/storage';
import { FirebaseError } from 'firebase/app';

const SESSION_ARCHIVE_RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

const sandbox = initializeSandbox();
const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
  rules: SESSION_ARCHIVE_RULES,
});

console.log('Storage ready with session-archive rules.');
```
Run `bun run archive.ts`. You should see `Storage ready with session-archive rules.`

## Step 2 — Upload a session
```ts
const sessionBytes = new TextEncoder().encode(JSON.stringify({
  id: 'gen-123',
  task: 'build a notes app',
  timestamp: '2026-05-12T00:00:00.000Z',
}));

const result = await uploadBytes(
  ref(alice, 'sessions/gen-123'),
  sessionBytes,
  {
    contentType: 'application/json',
    customMetadata: { sessionId: 'gen-123' },
  },
);

console.log('Uploaded:', result.metadata.fullPath, result.metadata.size, 'bytes');
```
Output: `Uploaded: sessions/gen-123 <some number> bytes`.

## Step 3 — List the archive
```ts
const items = await listAll(ref(alice, 'sessions'));
console.log('Sessions in archive:', items.items.map((i) => i.name));
```
Output: `Sessions in archive: [ 'gen-123' ]`.

Add more uploads and re-run — they appear in the list.

## Step 4 — Download a session
```ts
const blob = await getBlob(ref(alice, 'sessions/gen-123'));
const text = await blob.text();
const parsed = JSON.parse(text);
console.log('Downloaded session:', parsed);
```
Output: the JSON you uploaded, round-tripped intact.

## Step 5 — Try an anonymous upload
```ts
const anon = getStorageSandbox(sandbox.withAuth(null), { rules: SESSION_ARCHIVE_RULES });
// Note: the second config call doesn't replace rules; the cached handle from Step 1
// already has them. We pass them again for clarity.

try {
  await uploadBytes(
    ref(anon, 'sessions/anonymous-tampering'),
    new TextEncoder().encode('{}'),
    { contentType: 'application/json' },
  );
} catch (e) {
  if (e instanceof FirebaseError && e.code === 'storage/unauthenticated') {
    console.log('Anonymous denied:', e.message);
  } else {
    throw e;
  }
}
```
Output: `Anonymous denied: ...`. The rule's `request.auth != null` clause fails for the unauthenticated context, the engine denies, the package throws `FirebaseError` with code `storage/unauthenticated`.

## Step 6 — Try an oversized upload
```ts
const tenMb = new Uint8Array(11 * 1024 * 1024);  // 11 MiB
try {
  await uploadBytes(
    ref(alice, 'sessions/too-big'),
    tenMb,
    { contentType: 'application/json' },
  );
} catch (e) {
  if (e instanceof FirebaseError && e.code === 'storage/unauthorized') {
    console.log('Oversize denied:', e.message);
  } else {
    throw e;
  }
}
```
Output: `Oversize denied: ...`. The rule's `request.resource.size < 10 * 1024 * 1024` check fails, the engine denies. `storage/unauthorized` (different from `unauthenticated`) signals "you're signed in but you can't do this".

## Step 7 — Delete
```ts
await deleteObject(ref(alice, 'sessions/gen-123'));
console.log('After delete:', (await listAll(ref(alice, 'sessions'))).items.length, 'items');
```
The delete works under the `request.resource == null` carve-out: the rule's write clause accepts the `null` payload case, which is what `deleteObject` produces.

## What you have learned

- `getStorageSandbox(ctx, { rules })` produces a sandbox-backed handle with rules wired at config time.
- `ref`, `uploadBytes`, `getBlob`, `listAll`, `deleteObject` are the building blocks.
- The Storage rules grammar supports `request.auth`, `request.resource`, `resource`, and standard operators.
- The `request.resource == null` carve-out is how delete rules co-exist with size/content-type checks.
- Errors come through as `FirebaseError` with `storage/` codes; catch by code.

## Where to go next

- Swap the backend to real Firebase Storage — see [Switch between sandbox and prod backends](../pyric-storage-how-to-switch-backends/).
- Round-trip custom metadata — see [Round-trip metadata](../pyric-storage-how-to-round-trip-metadata/).
- Read about what's deferred from this v1 scope — see [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/).
