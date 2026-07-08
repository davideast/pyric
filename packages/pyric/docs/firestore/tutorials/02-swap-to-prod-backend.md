# Swap the demo to the prod backend

In this tutorial you will take the demo from [Write a sandbox-backed demo](./01-write-a-sandbox-demo.md) and swap it to talk to a real Firebase project. The only code change is one line.

This tutorial assumes you have a Firebase project with Firestore enabled and a config object handy.

## Before you start

In the project folder from Tutorial 1:

```bash
bun add firebase
```

`firebase` is the upstream Web SDK. `pyric/firestore`'s prod backend dispatches through it.

## Step 1 — The one-line change

Replace this:

```ts
import { initializeSandbox } from 'pyric/sandbox';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
```

With this:

```ts
import { initializeApp } from 'firebase/app';

const app = initializeApp({
  projectId: 'your-project-id',
  // ... rest of your Firebase config
});
const db = getFirestore(app);
```

That's the swap. Everything else in `demo.ts` — `setDoc`, `getDoc`, `query`, `onSnapshot`, the writes, the reads, the listener — stays unchanged.

## Step 2 — What won't work anymore

Three calls will fail:

```ts
sandboxOps.setRules(db, ...);     // throws 'failed-precondition'
sandboxOps.seedDocuments(db, ...); // throws 'failed-precondition'
sandboxOps.snapshotState(db);     // throws 'failed-precondition'
```

The sandbox namespace operations are sandbox-only by design. On prod, deploy rules through `pyric-tools/deploy`:

```ts
import { fromServiceAccount, firestore } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
await firestore.rules.deploy(scope, `rules_version = '2'; ...`);
```

Seed data via writes, just like any other production code. Dump state — there's no efficient API on the prod side, but you can iterate collections via `getDocs`.

## Step 3 — Make sure rules are deployed

The sandbox-shaped tutorial deployed rules inline. On prod, you need rules deployed *before* you run the code, or every write will deny. Two options:

### Deploy via the Firebase CLI

```bash
firebase deploy --only firestore:rules
```

The CLI reads your local `firestore.rules` and pushes it.

### Deploy programmatically

If you're running the demo as part of a larger script:

```ts
import { fromServiceAccount, firestore } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
await firestore.rules.deploy(scope, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);
```

## Step 4 — Auth

The sandbox version used `sandbox.withAuth({ uid: 'alice' })` to act as Alice. On prod, the user identity comes from Firebase Auth:

```ts
import { getAuth, signInAnonymously } from 'firebase/auth';

const auth = getAuth(app);
await signInAnonymously(auth);
// Now `auth.currentUser.uid` is the user identity rules will see.
```

For server-side scripts, sign in with a custom token or run as a service account. The details depend on your project's auth setup.

## Step 5 — Run it

With rules deployed and a user signed in:

```bash
bun run demo.ts
```

The same writes, the same reads, the same listener. The output will be similar, with two key differences:

- Operations take tens to hundreds of milliseconds instead of sub-millisecond.
- `snap.metadata.fromCache` and `snap.metadata.hasPendingWrites` reflect real cache state.

The denied write from Step 6 of Tutorial 1 still denies, with a `FirebaseError('firestore/permission-denied')` instead of a `SandboxError` — the upstream SDK's error class.

## What's actually under the hood

`pyric/firestore`'s `getFirestore(app)` calls `firebase/firestore`'s `getFirestore(app)` and tags the result with a prod target. Every subsequent function call (`doc`, `setDoc`, etc.) dispatches to the upstream SDK's equivalent.

There's no proxy, no wrapper, no overhead. The package is mostly the dispatch layer plus type re-exports.

## What you have learned

- The same demo code runs against two completely different backends.
- The choice happens at `getFirestore(...)` — one line.
- Sandbox-only operations throw on prod handles, surfacing the mistake immediately.
- Auth, error types, and metadata fields are the main behavioural deltas.

## Where to go next

- For deploying rules to prod, see [`pyric-tools/deploy`'s firestore namespace](../../../../pyric-tools/docs/deploy/reference/firestore-namespace.md).
- For why the two-backend story works, see [Why two backends behind one surface](../explanation/two-backends-one-surface.md).
- For a real migration from `firebase/firestore`, see [Migrate from `firebase/firestore`](../how-to/migrate-from-firebase-firestore.md).
