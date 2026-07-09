---
title: "Your first sandbox session"
group: "pyric / sandbox"
section: "Tutorials"
order: 90
---
# Your first sandbox session

In this tutorial you will create a sandbox, deploy a tiny set of rules, write a document as one user, deny a read as another, and inspect the result. By the end you'll have seen the three core ideas — `Sandbox`, `SandboxContext`, `SandboxError` — work together in one short script.

No Firebase project, no network, no setup beyond an `npm install`.

## What you will build

A standalone script that creates a sandbox, runs three operations against it, and prints what happened.

## Step 1 — Set up
```bash
mkdir sandbox-tutorial && cd sandbox-tutorial
bun init -y
bun add pyric/sandbox pyric-admin
```
`pyric-admin` gives us the Admin-SDK-shaped data plane that sits on top of the sandbox. (You could use `pyric/firestore` for the modular Web shape instead; the choice doesn't matter for this tutorial.)

## Step 2 — Create the sandbox and deploy rules

Create `session.ts`:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();

const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
const adminDb = getFirestore(adminCtx);

adminDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);

console.log('Sandbox ready, rules deployed.');
```
Notice three things:

- `initializeSandbox()` takes no arguments. Identity comes later, via `withAuth`.
- The admin context uses a custom `token.admin` claim. The rule doesn't check for it here — we'll use it shortly when we want to bypass user-shape rules.
- `setRules` is part of `pyric-admin`'s handle, not the sandbox itself. The sandbox is identity-agnostic; deploying rules is conceptually identity-agnostic too, but the surface lives on the data-plane adapter for ergonomics.

Run it:
```bash
bun run session.ts
```
You should see `Sandbox ready, rules deployed.` and nothing else.

## Step 3 — Write as one user, read as another

Add to `session.ts`:
```ts
const alice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bob = getFirestore(sandbox.withAuth({ uid: 'bob' }));

await alice.collection('notes').doc('n1').set({
  ownerId: 'alice',
  title: 'My first note',
});

const aliceRead = await alice.collection('notes').doc('n1').get();
console.log('Alice sees:', aliceRead.data());

const bobRead = await bob.collection('notes').doc('n1').get();
console.log('Bob sees:', bobRead.data());
```
Run it again. You will see:
```
Sandbox ready, rules deployed.
Alice sees: { ownerId: "alice", title: "My first note" }
Bob sees: { ownerId: "alice", title: "My first note" }
```
Both reads succeed because the rule says `allow read: if request.auth != null` — any signed-in user can read any note. The two contexts share data; they differ only in the identity rules evaluate under.

## Step 4 — Watch a denial

Add:
```ts
import { SandboxError } from 'pyric/sandbox';

try {
  await bob.collection('notes').doc('n1').set({
    ownerId: 'alice',  // Bob lies about who owns it
    title: 'Bob tampers',
  });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log('Bob was denied.');
    console.log('  Reasons:', e.denialContext?.reasons);
    console.log('  Request method:', e.denialContext?.request?.method);
  } else {
    throw e;
  }
}
```
Run. You will see:
```
Bob was denied.
  Reasons: [ "Rule #1 (write) → deny", "Simulated: DENY" ]
  Request method: update
```
The write rule is `request.auth.uid == request.resource.data.ownerId`. Bob's `auth.uid` is `'bob'`; the proposed payload's `ownerId` is `'alice'`. They don't match, the rule denies, the SDK throws `SandboxError` with `code: 'permission-denied'`.

`denialContext` carries the full eval-time payload — what the rule saw, why it said no. Real Firebase strips this server-side for security; the sandbox can show it because it's a development tool.

## Step 5 — Use admin reads to confirm state

Add:
```ts
console.log('Actual data:', sandbox.admin.getDocument('notes/n1'));
```
Output:
```
Actual data: { ownerId: "alice", title: "My first note" }
```
`sandbox.admin.getDocument` bypasses rules entirely. It tells you what the data is, regardless of whether any specific user can read it. Bob's attempted overwrite never happened (the rule denied it), so the document still has Alice's original payload.

This is how you assert state in tests without worrying about whether your test fixture's identity can read what you want to verify.

## Step 6 — Watch a reset

Add at the end:
```ts
sandbox.reset();
console.log('After reset:', sandbox.admin.getDocument('notes/n1'));
console.log('Alice context still works:', !!alice);
```
Output:
```
After reset: null
Alice context still works: true
```
`reset` wipes data, rules, listeners — but the `alice` and `bob` contexts still work. Their sandbox reference is stable; the underlying environment was replaced. The next operation through `alice` would evaluate against the fresh environment (and would fail because rules are gone — default-deny applies).

## What you have learned

- `initializeSandbox()` produces an identity-agnostic sandbox.
- `sandbox.withAuth(...)` derives a `SandboxContext` for a specific identity.
- Data-plane adapters (`pyric-admin`) accept a context and provide the Firestore API.
- Denied operations throw `SandboxError('permission-denied')` carrying a structured `denialContext`.
- `sandbox.admin` bypasses rules for state assertions.
- `sandbox.reset()` swaps the underlying environment but keeps context references alive.

## What to do next

- Run the same pattern across a test suite — see [Use the sandbox in a test harness](../pyric-sandbox-tutorials-02-use-the-sandbox-in-a-test-harness/).
- Render denials in a UI without try/catch — see [Observe sandbox events](../pyric-sandbox-how-to-observe-events/).
- Pick between the two adapter shapes — see [Pick between `pyric-admin` and `pyric/firestore`](../pyric-sandbox-how-to-pick-an-adapter/).
