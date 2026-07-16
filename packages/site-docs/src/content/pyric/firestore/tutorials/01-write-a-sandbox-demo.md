---
title: "Write a sandbox-backed demo"
navLabel: "Sandbox-backed demo"
group: "pyric / firestore"
section: "Tutorials"
order: 20
---
# Write a sandbox-backed demo

Build a tiny notes app with `pyric/firestore` against the sandbox backend. By the end you'll have set rules, seeded data, written, read, watched a query, and seen a denial, all in-process.

## Set up

```bash
mkdir notes-demo && cd notes-demo
bun init -y
bun add pyric
```

## Step 1: Boot the sandbox and a Firestore handle

Create `demo.ts`:

```ts
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
} from 'pyric/firestore';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

console.log('Sandbox-backed Firestore ready.');
```

Run with `bun run demo.ts`. You should see the line and nothing else.

## Step 2: Deploy rules

```ts
const lint = setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
console.log('Rules deployed.');
```

Firestore controls receive the owning `Sandbox`, while data-plane functions
receive `db`. Lint warnings are visible. Surface them if any are errors.

## Step 3: Write and read

```ts
await setDoc(doc(db, 'notes', 'n1'), {
  ownerId: 'alice',
  title: 'My first note',
});

const snap = await getDoc(doc(db, 'notes', 'n1'));
console.log('Read back:', snap.data());
```

Output: `Read back: { ownerId: "alice", title: "My first note" }`.

## Step 4: Query

```ts
import { getDocs } from 'pyric/firestore';

await setDoc(doc(db, 'notes', 'n2'), {
  ownerId: 'alice',
  title: 'Second note',
  archived: true,
});
await setDoc(doc(db, 'notes', 'n3'), {
  ownerId: 'alice',
  title: 'Third note',
});

const q = query(
  collection(db, 'notes'),
  where('archived', '!=', true),  // null and false both qualify
);
const results = await getDocs(q);
console.log(`Found ${results.size} unarchived notes:`);
results.forEach((d) => console.log(' ', d.id, d.data().title));
```

Output:

```
Found 2 unarchived notes:
  n1 My first note
  n3 Third note
```

The query runs against the sandbox's `LocalEnvironment`, no network. The filter evaluates correctly on `getDocs`.

## Step 5: Watch with `onSnapshot`

```ts
const changes: string[] = [];
const unsubscribe = onSnapshot(
  query(collection(db, 'notes')),
  (snap) => {
    for (const change of snap.docChanges()) {
      changes.push(`${change.type} ${change.doc.id}`);
    }
  },
);

await setDoc(doc(db, 'notes', 'n4'), {
  ownerId: 'alice',
  title: 'Watched note',
});

await new Promise((resolve) => setTimeout(resolve, 10));  // let the listener fire

console.log('Saw changes:', changes);
unsubscribe();
```

Output something like:

```
Saw changes: [
  'added n1', 'added n2', 'added n3',  // initial fire
  'added n4',                          // write
]
```

## Step 6: Try a denied write

```ts
const bob = getFirestore(sandbox.withAuth({ uid: 'bob' }));

try {
  await setDoc(doc(bob, 'notes', 'b1'), {
    ownerId: 'alice',  // Bob lies about ownership
    title: 'tamper',
  });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log('Bob was denied:', e.denialContext?.reasons?.[0]);
  }
}
```

Output: `Bob was denied: Rule #1 (write) → deny`. The write rule checks `request.auth.uid == request.resource.data.ownerId`. Bob's UID doesn't match Alice's, so the rule denies and `SandboxError` surfaces with full context.

## Step 7: Dump the state

```ts
console.log('Final state:', snapshotDocuments(sandbox));
```

Every stored document, including Alice's writes and excluding Bob's denied one.

## What you have learned

- `getFirestore(sandbox.withAuth(...))` produces a sandbox-backed handle.
- The function shape (`doc`, `setDoc`, `getDoc`, `onSnapshot`) matches `firebase/firestore`.
- Firestore controls such as `setRules` and `snapshotDocuments` are sandbox-only and live at `pyric/sandbox/firestore`.
- `SandboxError` with `denialContext` is the same shape you see from `pyric-admin` and from `Sandbox.onDenial`.

## What to do next

The same canonical Firebase imports can select this mirror in development and
remain Firebase in production. Follow [Run the demo against production](./02-swap-to-prod-backend.md)
to see how package resolution controls that boundary.
