# How to round-trip metadata

This guide shows you how to set, read, and update Storage object metadata.

## Set metadata at upload

```ts
import { ref, uploadBytes } from 'pyric/storage';

const result = await uploadBytes(
  ref(storage, 'sessions/n1'),
  new Blob([jsonString]),
  {
    contentType: 'application/json',
    cacheControl: 'private, max-age=3600',
    customMetadata: {
      sessionId: 'n1',
      generatedBy: 'agent-runtime',
      version: '1.0',
    },
  },
);

console.log(result.metadata);
```

`SettableMetadata` is what you pass in. `FullMetadata` is what you read back. It includes server-set fields (`bucket`, `fullPath`, `generation`, `metageneration`, `md5Hash`, `name`, `size`, `timeCreated`, `updated`) alongside the settable ones.

## Read metadata

```ts
import { getMetadata } from 'pyric/storage';

const meta = await getMetadata(ref(storage, 'sessions/n1'));
console.log(meta.contentType);          // 'application/json'
console.log(meta.size);                 // bytes
console.log(meta.customMetadata?.sessionId);  // 'n1'
```

Throws `storage/object-not-found` if the path has no stored object.

## Patch metadata

`updateMetadata` replaces the settable fields with what you pass:

```ts
import { updateMetadata } from 'pyric/storage';

const updated = await updateMetadata(ref(storage, 'sessions/n1'), {
  cacheControl: 'public, max-age=86400',
  customMetadata: {
    sessionId: 'n1',
    version: '1.1',          // changed
    generatedBy: 'agent-runtime',
    annotation: 'reviewed',  // added
  },
});

console.log(updated.metageneration);  // incremented
console.log(updated.updated);          // refreshed timestamp
```

The blob content is untouched. `metageneration` bumps; `updated` refreshes. Server-set fields (`generation`, `timeCreated`, `bucket`, `size`, `md5Hash`) stay pinned.

## Partial vs full

`updateMetadata` is a **replace** of the settable fields, not a merge. Fields you don't pass come back undefined:

```ts
// Before: cacheControl='private', customMetadata={a:'1',b:'2'}

await updateMetadata(ref, { customMetadata: { a: '1' } });

// After: cacheControl=undefined, customMetadata={a:'1'}
```

If you want to keep existing fields, fetch first and merge:

```ts
const current = await getMetadata(ref);
await updateMetadata(ref, {
  cacheControl: current.cacheControl,
  customMetadata: { ...current.customMetadata, newKey: 'newValue' },
});
```

This mirrors `firebase/storage`'s behaviour. The replace semantics avoid hidden merge semantics that vary across SDK versions.

## Custom metadata is string-to-string

`customMetadata` is `Record<string, string>`. Numbers, booleans, and objects need to be serialised manually:

```ts
await uploadBytes(ref, data, {
  customMetadata: {
    count: '42',
    isActive: 'true',
    payload: JSON.stringify({ a: 1, b: 2 }),
  },
});
```

This matches the upstream contract. The strings round-trip exactly.

## When metadata is denied

A rule that gates `write` (matching `updateMetadata` calls) can deny the patch. The package throws `FirebaseError('storage/unauthorized')` or `'storage/unauthenticated'`. Catch and branch as in [Error codes](../reference/error-codes.md).

## Where to look next

- For the field-by-field metadata shapes, see [`FullMetadata`](https://pyric.dev/docs/pyric-storage-reference-api/#fullmetadata) and [`SettableMetadata`](https://pyric.dev/docs/pyric-storage-reference-api/#settablemetadata).
- For metadata in rules, see [Storage rules subset: Resource bindings](../reference/rules-subset.md#resource-bindings).
