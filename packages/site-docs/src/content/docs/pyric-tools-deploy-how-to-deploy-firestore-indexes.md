---
title: "How to deploy Firestore indexes"
navLabel: "Deploy Firestore indexes"
group: "pyric-tools / deploy"
section: "How-to"
order: 20
---
# How to deploy Firestore indexes

This guide shows you how to deploy a `firestore.indexes.json`-shaped config and how to wait for the resulting builds.

## Deploy a batch
```ts
import { firestore, type IndexesConfig } from 'pyric-tools/deploy';

const config: IndexesConfig = {
  indexes: [
    {
      collectionGroup: 'orders',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'userId', order: 'ASCENDING' },
        { fieldPath: 'createdAt', order: 'DESCENDING' },
      ],
    },
  ],
};

const outcome = await firestore.indexes.deployAll(scope, config);

if (outcome.ok) {
  console.log(`Started ${outcome.operationsStarted.length} index builds`);
  console.log(`Already existed: ${outcome.alreadyExists}`);
} else {
  console.error(`[${outcome.code}] ${outcome.message}`);
  if (outcome.partial) console.error('Partial results:', outcome.partial);
}
```
Per-entry status lives in `outcome.perIndex`:
```ts
for (const entry of outcome.perIndex) {
  console.log(
    `${entry.collectionGroup} [${entry.fieldsSummary.join(', ')}] → ${entry.status}`,
  );
}
```
## Validate before deploying

`deployAll` validates the config shape before issuing any HTTP calls. Common issues:

- A field must specify exactly one of `order`, `arrayConfig`, or `vectorConfig`. Two or zero produces `invalid-config`.
- `queryScope` must be `'COLLECTION'` or `'COLLECTION_GROUP'`.
- `collectionGroup` must be a non-empty string.

The validator runs synchronously and never touches the network, so a config built dynamically (from user input, from another file) can be checked cheaply.

## Handle partial failures

When a 403 hits mid-batch, `deployAll` aborts and returns `{ ok: false, code: 'permission-denied', partial }`. `partial` carries the operations that did start before the failure plus their `perIndex` entries — you can present the user with "12 started, 4 not attempted" instead of pretending nothing happened.

For non-403 per-index failures, the batch continues. Final result is `{ ok: false, code: 'create-failed' }` with `perIndex` showing which entries succeeded and which failed.

## Deploy a single index

For one-off cases:
```ts
const op = await firestore.indexes.create(scope, {
  collectionGroup: 'users',
  queryScope: 'COLLECTION',
  fields: [{ fieldPath: 'email', order: 'ASCENDING' }],
});

console.log('Started operation:', op.name);
```
This is the primitive — it throws `AdminApiError` on non-2xx instead of returning an outcome.

## Wait for a build to finish

Index builds are long-running operations. Poll with `getStatus`:
```ts
const status = await firestore.indexes.getStatus(scope, op.name);

if (status.ok) {
  console.log(`State: ${status.state}`);   // 'CREATING' | 'READY' | 'NEEDS_REPAIR' | 'NOT_FOUND'
} else {
  console.error(`[${status.code}] ${status.message}`);
}
```
Build times depend on collection size — small collections take seconds, large ones can take hours. Poll on a backoff loop, or surface the operation name to the user and let them check the Firebase Console.

## Required IAM

The service account / signed-in user needs `datastore.indexes.create` and `datastore.indexes.get`. Both are subsumed by the Firebase Admin role.

## Where to look next

- For the index wire shape, see [`firestore` namespace — index wire shapes](../pyric-tools-deploy-reference-firestore-namespace/#index-wire-shapes).
- For all the error codes the outcomes can return, see [Error codes by operation — Firestore indexes](../pyric-tools-deploy-reference-error-codes/#firestore-indexes).
