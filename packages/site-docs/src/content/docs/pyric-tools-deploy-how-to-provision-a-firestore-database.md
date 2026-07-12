---
title: "How to provision a Firestore database"
navLabel: "Provision a database"
group: "pyric-tools / deploy"
section: "How-to"
order: 9012
---
# How to provision a Firestore database

This guide shows you how to create (or confirm the existence of) a Firestore database in a Firebase project.

## Idempotent provision

```ts
import { firestore } from 'pyric-tools/deploy';

const outcome = await firestore.databases.provision(scope);

if (outcome.ok) {
  if (outcome.status === 'created') {
    console.log('Created database. Operation:', outcome.operationName);
  } else {
    console.log('Database already exists');
  }
} else {
  console.error(`[${outcome.code}] ${outcome.message}`);
}
```

`provision` probes via `GET .../databases/(default)` first. If the database exists, it short-circuits with `status: 'already-exists'` and no further calls. If not, it creates one and returns the long-running operation name.

## Pick a region and database id

Defaults are `(default)` and `nam5`. To target a named database in a specific multi-region:

```ts
const outcome = await firestore.databases.provision(scope, {
  databaseId: 'analytics',
  locationId: 'eur3',
});
```

The location can be a multi-region (`nam5`, `eur3`) or a region (`us-central1`, `europe-west3`). The full list lives in [Firestore's locations doc](https://firebase.google.com/docs/firestore/locations).

## Datastore mode

For new projects that want Datastore mode instead of Native:

```ts
await firestore.databases.provision(scope, { type: 'DATASTORE_MODE' });
```

Note: `pyric/firestore` and `pyric-admin` target the Native API only. Provisioning Datastore mode disables those packages for the project.

## Wait for the data plane

After `status: 'created'`, the database resource is registered but its data plane takes ~30 seconds to come online. Callers that need strict ordering should poll the operation before issuing writes:

```ts
import { functions } from 'pyric-tools/deploy';

if (outcome.ok && outcome.status === 'created' && outcome.operationName) {
  // The operation API is the same shape for databases and functions.
  await functions.pollOperation(scope, outcome.operationName);
}
```

For most consumer flows, a single `await new Promise(r => setTimeout(r, 30_000))` after the create is enough.

## Required IAM

- `datastore.databases.get`
- `datastore.databases.create`

Both are subsumed by Owner / Editor / Firebase Admin.

## Where to look next

- For the `ProvisionDatabaseOutcome` shape and options, see [`firestore` namespace: `databases`](../pyric-tools-deploy-reference-firestore-namespace/#firestoredatabases).
- For the matching error codes, see [Error codes by operation: Firestore databases](../pyric-tools-deploy-reference-error-codes/#firestore-databases).
