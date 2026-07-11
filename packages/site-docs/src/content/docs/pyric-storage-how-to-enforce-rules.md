---
title: "How to enforce Storage rules"
navLabel: "Enforce Storage rules"
group: "pyric / storage"
section: "How-to"
order: 145
---
# How to enforce Storage rules

This guide shows you how to wire Storage rules into a sandbox-backed handle and watch them gate uploads, reads, and deletes.

## Pass rules at config time
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';

const RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{id} {
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

const sandbox = initializeSandbox();
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
  rules: RULES,
});
```
The `rules` source is parsed eagerly: malformed source throws a `SyntaxError` at handle construction. After config, every operation evaluates against the rules.

## The `request.resource == null` carve-out

Notice this in the rule:
```rules
allow write: if request.auth != null
             && (request.resource == null
                 || (request.resource.size < 10 * 1024 * 1024
                     && request.resource.contentType == 'application/json'));
```
`deleteObject` doesn't carry a payload, so `request.resource` evaluates to `null`. Without the carve-out, the size and content-type checks would fail (you can't read `.size` from `null`) and every delete would deny.

The pattern is standard in production Storage rules. Match it.

## Operations match umbrella and granular verbs

| Function | Umbrella verb | Granular verb |
|---|---|---|
| `getBytes`, `getBlob`, `getMetadata` | `read` | `get` |
| `uploadBytes`, `uploadString` (new path) | `write` | `create` |
| `uploadBytes`, `uploadString` (existing path), `updateMetadata` | `write` | `update` |
| `deleteObject` | `write` | `delete` |
| `listAll` | `read`, evaluated against the listed folder path (see [List and delete](../pyric-storage-how-to-list-and-delete/)) | `list` |

Write rules with the umbrella verbs (`read`/`write`) when the distinction doesn't matter, or the granular verbs when it does — production semantics either way.

## Served mode enforces rules too

Under `pyric dev`, rules load into the served worker at boot and gate every operation the same as the in-process sandbox. Unlike `firestore.rules` and `database.rules.json`, `storage.rules` doesn't hot-reload — editing it while the dev server is running requires a restart to take effect.

## Switching users to test rules
```ts
const aliceStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { rules: RULES });
const anonStorage = getStorageSandbox(sandbox.withAuth(null), { rules: RULES });

// Alice uploads successfully.
await uploadBytes(ref(aliceStorage, 'sessions/n1'), jsonBlob, { contentType: 'application/json' });

// Anonymous upload denies.
try {
  await uploadBytes(ref(anonStorage, 'sessions/n2'), jsonBlob, { contentType: 'application/json' });
} catch (e) {
  console.log(e.code);  // 'storage/unauthenticated'
}
```
The rules engine sees `request.auth.uid == 'alice'` in the first call and `request.auth == null` in the second.

The `rules` option only takes effect on the *first* `getStorageSandbox` call per sandbox. Subsequent calls return the cached handle, and its rules apply uniformly to every user via that sandbox.

## Catching denials

`pyric/storage` throws `FirebaseError` (from `firebase/app`) with Firebase-aligned codes:
```ts
import { FirebaseError } from 'firebase/app';

try {
  await uploadBytes(ref(storage, 'sessions/oversized'), bigBlob);
} catch (e) {
  if (e instanceof FirebaseError) {
    if (e.code === 'storage/unauthorized') {
      console.error('Denied by rules:', e.message);
    } else {
      throw e;
    }
  }
}
```
See [Error codes](../pyric-storage-reference-error-codes/) for every code the sandbox can emit.

## Testing rule expressions without uploading

If you want to test a rule expression in isolation:
```ts
import { parseStorageRules, evaluateStorageRules } from 'pyric/storage';

const parsed = parseStorageRules(RULES);
const decision = evaluateStorageRules(parsed, {
  path: 'b/pyric-default/o/sessions/n1',
  method: 'create',
  auth: { uid: 'alice', token: {} },
  resource: { size: 100, contentType: 'application/json' },
});
console.log(decision);  // { allowed: true }
```
Useful when iterating on rule logic. See [Test rule expressions independently](../pyric-storage-how-to-test-rule-expressions/).

## Where to look next

- For the supported rule grammar, see [Storage rules subset](../pyric-storage-reference-rules-subset/).
- For the carve-out and other production patterns, see the [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/) page.
