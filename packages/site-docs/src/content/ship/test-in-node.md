---
title: Run the same backend in tests and scripts
navLabel: Test in Node
outcome: Run your rules and data logic in a Node test suite, with no browser and no emulator.
status: draft
---

# Run the same backend in tests and scripts

The backend that runs in your browser tab runs in a Node process the same way. That means your test suite gets a real Firestore with real rules enforcement, in-process, with nothing to start or tear down. No browser. No emulator. No port.

## A test harness against the sandbox

One sandbox at module scope, contexts derived once, reset in `beforeEach`. This is Bun's runner; the structure is identical with Vitest or Jest.

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
      allow update, delete: if request.auth.uid == resource.data.ownerId;
    }
  }
}`;

const sandbox = initializeSandbox();
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bobDb = getFirestore(sandbox.withAuth({ uid: 'bob' }));

beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
});

describe('notes rules', () => {
  it('lets the owner create a note', async () => {
    await aliceDb.collection('notes').doc('n1').set({ ownerId: 'alice', title: 'first' });
    expect(sandbox.admin.getDocument('notes/n1')).toEqual({ ownerId: 'alice', title: 'first' });
  });

  it('denies writes that misattribute ownership', async () => {
    let err: unknown;
    try {
      await bobDb.collection('notes').doc('n2').set({ ownerId: 'alice', title: 'tamper' });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
    expect(sandbox.admin.getDocument('notes/n2')).toBeNull();
  });
});
```

Notice the division of labor. Writes go through user contexts, so the rules are what's under test. Assertions go through `sandbox.admin.getDocument`, which bypasses rules, so a test can confirm the state without depending on a read rule.

The denial test asserts three layers: the throw, the error code, and that the state did not change.

## The admin shape, one line from production

Server code written against `firebase-admin` runs on the sandbox with a single changed line:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { initializeApp } from 'pyric-admin/app';

const app = initializeApp({ sandbox: initializeSandbox() });
```

Or with zero changed lines. Under `pyric dev`, the activated
`@pyric/cli/register` resolver maps canonical `firebase-admin/*` imports to
`pyric-admin/*` and a bare `initializeApp()` uses the sandbox. With activation
absent, normal package resolution loads `firebase-admin` directly. Your source
carries no Pyric identifiers at all.

`pyric dev` sets that variable and preloads the resolver for the development command it runs. A guard refuses sandbox routing when `NODE_ENV` is `production`, so the swap cannot follow you to production execution.

## One backend across app, Node, and agent

Under `pyric dev` the backend lives in a SharedWorker in the browser, and a Node process can attach to it remotely: the admin handle relays operations over the dev server's bridge to that same worker. Your open tab, your script, and an agent on the MCP bridge all see one pool of documents and users, live.

It is a relay, so it has edges worth knowing:

- The browser tab must stay open.
- Remote Storage is single-bucket with an 8 MiB per-operation cap.
- Anything unimplemented throws an explicit error with a remediation, never wrong data.

## Verification is a test too

Your captured dev sessions double as a suite:

```bash
pyric verify journeys/
```

It replays every fixture in the directory against candidate rules and exits non-zero on a real divergence, which slots straight into CI next to your unit tests. See [Ship to production](./ship-to-production.md).

## Where to go next

The seed and reset patterns these tests lean on are covered in [Shape your data](../observe/shape-your-data.md). To watch a failing test's traffic instead of guessing, see [See what's happening](../observe/see-whats-happening.md).
