---
title: "Use the sandbox in a test harness"
navLabel: "Sandbox in a test harness"
group: "pyric / sandbox"
section: "Tutorials"
order: 121
---
# Use the sandbox in a test harness

In this tutorial you will wire `pyric/sandbox` into a real test suite. By the end you will have:

1. A single sandbox shared across every test in a file.
2. A `beforeEach` that resets state between tests.
3. Helpers that seed the sandbox before each case.
4. Assertions that mix user-shaped reads with admin reads.

This tutorial assumes you completed [Your first sandbox session](../pyric-sandbox-tutorials-01-your-first-sandbox-session/) and you have `pyric/sandbox` and `pyric-admin` installed. It uses Bun's test runner; the structure is identical with Vitest or Jest.

## What you will build

A file `notes.test.ts` that exercises rules for a notes collection. Three tests: a successful write, a denied write, an admin-read assertion.

## Step 1 — Module-level setup

Create `notes.test.ts`:
```ts
import { describe, it, beforeEach, expect } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow create: if request.auth.uid == request.resource.data.ownerId;
      allow update, delete:
        if request.auth.uid == resource.data.ownerId;
    }
  }
}`;

const sandbox = initializeSandbox();
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bobDb = getFirestore(sandbox.withAuth({ uid: 'bob' }));
```
Three contexts at module scope. They're cheap to create and survive every reset (the sandbox object identity is stable).

## Step 2 — Reset and seed in `beforeEach`
```ts
beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
});
```
Every test starts with no documents and the rules freshly deployed. `setRules` lives on `pyric-admin`'s handle — the admin context's token doesn't matter for rule deployment (any context will do), but the convention of "all admin-plane operations through the admin context" makes the test code read clearly.

If your tests share a setup (e.g. always have a `notes/system` doc), do it here:
```ts
beforeEach(async () => {
  sandbox.reset();
  adminDb.setRules(RULES);
  // Direct admin write — bypasses rules, useful for fixture docs.
  await adminDb.collection('notes').doc('system').set({ ownerId: 'system', title: 'pinned' });
});
```
Admin context writes evaluate against the same rules as anyone else. If your rules reject `admin`-authed writes for fixture docs, use `/internal` seeding instead — see [Seed initial data and rules](../pyric-sandbox-how-to-seed-data-and-rules/).

## Step 3 — First test: a successful write
```ts
describe('notes rules', () => {
  it('lets the owner create a note', async () => {
    await aliceDb.collection('notes').doc('n1').set({
      ownerId: 'alice',
      title: 'My first note',
    });

    const data = sandbox.admin.getDocument('notes/n1');
    expect(data).toEqual({ ownerId: 'alice', title: 'My first note' });
  });
});
```
Two things to notice:

- The write goes through `aliceDb` — evaluated under Alice's identity.
- The assertion uses `sandbox.admin.getDocument` — bypasses rules. This lets the test confirm "the write landed" without depending on a successful read rule.

Run:
```bash
bun test
```
You should see one passing test.

## Step 4 — Second test: a denied write
```ts
it('denies writes that misattribute ownership', async () => {
  let err: unknown;
  try {
    await bobDb.collection('notes').doc('n2').set({
      ownerId: 'alice',  // Bob can't write this
      title: 'tamper',
    });
  } catch (e) {
    err = e;
  }

  expect(err).toBeInstanceOf(SandboxError);
  expect((err as SandboxError).code).toBe('permission-denied');
  expect(sandbox.admin.getDocument('notes/n2')).toBeNull();
});
```
The assertion now has three layers:

- The throw happened.
- It was a `permission-denied` `SandboxError`.
- The state didn't change (admin read confirms the doc wasn't written).

This "three-layer assertion" pattern catches drift between intent and reality. A bug that lets the write through silently would fail layer three even if layer two looked fine.

## Step 5 — Third test: a user-shaped read
```ts
it('allows any authed user to read', async () => {
  // Seed under admin's identity — fixture doc, rule-bypass via /internal would
  // be cleaner, but for this rule the admin context's auth.uid happens to
  // satisfy the `request.auth.uid == ownerId` check. Set ownerId accordingly.
  await adminDb.collection('notes').doc('n3').set({
    ownerId: 'admin',
    title: 'public note',
  });

  const snap = await bobDb.collection('notes').doc('n3').get();
  expect(snap.exists).toBe(true);
  expect(snap.data()).toEqual({ ownerId: 'admin', title: 'public note' });
});
```
This test exercises a user-shaped read, not an admin read. The point is to verify that `bob` *can* read — not just that the doc exists. Use admin reads for state assertions; use user-shaped reads to test rules.

## Step 6 — Observe denials in a debugging test

Add a sanity-check test that captures every denial that fires during the run:
```ts
import { beforeAll, beforeEach, afterAll } from 'bun:test';
import type { RequestEvent } from 'pyric/sandbox';

let denials: RequestEvent[] = [];
let unsubDenial: (() => void) | undefined;

beforeAll(() => {
  // Subscribe ONCE — onEvent survives reset(), so the same callback
  // captures denials across every test in the suite.
  unsubDenial = sandbox.onEvent((event) => {
    if (event.kind === 'request' && event.result === 'deny') denials.push(event);
  });
});

beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
  denials = [];
});

afterAll(() => {
  unsubDenial?.();
});

it('records exactly one denial when bob tampers', async () => {
  try {
    await bobDb.collection('notes').doc('n4').set({ ownerId: 'alice', title: 'tamper' });
  } catch (e) { /* expected */ }

  expect(denials.length).toBe(1);
  expect(denials[0].result).toBe('deny');
});
```
`onEvent` fires regardless of whether your test code catches the throw, and the subscription survives `reset()` — subscribe once in `beforeAll`. The `denials` array clears at the start of each test; everything between reset and the next test's first op gets attributed correctly.

## Putting it together
```ts
import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const RULES = /* rules from Step 1 */;

const sandbox = initializeSandbox();
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bobDb = getFirestore(sandbox.withAuth({ uid: 'bob' }));

let denials: RequestEvent[] = [];
let unsubDenial: (() => void) | undefined;

beforeAll(() => {
  unsubDenial = sandbox.onEvent((event) => {
    if (event.kind === 'request' && event.result === 'deny') denials.push(event);
  });
});

beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
  denials = [];
});

afterAll(() => unsubDenial?.());

describe('notes rules', () => {
  it('lets the owner create a note', async () => { /* ... */ });
  it('denies writes that misattribute ownership', async () => { /* ... */ });
  it('allows any authed user to read', async () => { /* ... */ });
  it('records exactly one denial when bob tampers', async () => { /* ... */ });
});
```
Run `bun test` — four passing tests.

## What you have learned

- One sandbox at module scope, reset in `beforeEach`. Contexts derived once.
- Admin reads (`sandbox.admin.getDocument`) for state assertions.
- User-shaped reads through the SDK adapter for testing rules.
- `onEvent` filtered to `kind: 'request' && result: 'deny'` for capturing denials without try/catch boilerplate.
- The "three-layer assertion" pattern: throw, error type, state change.

## What to do next

- For more on the test patterns, see [Reset between tests](../pyric-sandbox-how-to-reset-between-tests/).
- For when admin reads are necessary, see [Use admin reads to assert in tests](../pyric-sandbox-how-to-use-admin-reads/).
- For multi-tenant test setups, see [Run multiple isolated sandboxes in parallel](../pyric-sandbox-how-to-multiple-isolated-sandboxes/).
