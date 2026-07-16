---
title: "How to reset between tests"
navLabel: "Reset between tests"
group: "pyric / sandbox"
section: "How-to"
order: 70
---
# How to reset between tests

Keep one sandbox alive across many tests without state leakage.

## The mental model

`Sandbox.reset()` wipes data, rules, and listeners, but the **sandbox object identity** is preserved. Existing `SandboxContext`s continue to work; their next operation resolves against the fresh environment under the hood.

That means you can hoist the sandbox to the top of a test file and reset before each case without re-deriving every context.

## Per-test reset with a shared sandbox
```ts
import { beforeEach } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const anonDb = getFirestore(sandbox.withAuth(null));

beforeEach(() => {
  sandbox.reset();
  // Re-deploy rules and seed if your tests need them.
  // … see "Seed initial data and rules"
});
```
After `reset`, the environment is empty: no documents, no rules (default-deny), no listeners. The `aliceDb` and `anonDb` references are still valid.

## Fresh sandbox per test

If your tests touch many sandboxes or you want truly nothing in common between them, build a new one each time:
```ts
import { beforeEach } from 'bun:test';

let sandbox = initializeSandbox();

beforeEach(() => {
  sandbox.dispose();
  sandbox = initializeSandbox();
});
```
`dispose()` drops listener registries on the outgoing instance defensively, useful when consumer code (rare; mostly tests) still holds a reference to the old sandbox.

## When listeners are involved

`reset()` calls `dispose()` on the outgoing environment before swapping. Snapshot listeners attached to that env are dropped, because their target docs were wiped.

`onEvent` subscribers, in contrast, **survive `reset()`**. The registry lives on the `Sandbox` itself; the env swap doesn't invalidate it. A `session_boundary` event with `phase: 'reset'` fires immediately before the swap so observers know the rollover happened. Code that subscribed in `beforeAll` keeps working across every `beforeEach` reset:
```ts
beforeAll(() => {
  unsubscribe = sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary') {
      // Persisted-stream consumers segment here.
    } else {
      events.push(event);
    }
  });
});

beforeEach(() => {
  sandbox.reset();
  events.length = 0;  // events array is shared; clear between tests.
});
```
Resubscribing on every reset works too, but isn't required.

## When parallel tests run in the same process

`pyric/sandbox` holds no module-level state. Two `initializeSandbox()` calls produce two independent sandboxes. Run them in parallel without any locking.

Where parallel tests *do* need care:

- **Shared resources** (a single Firebase project, a single set of credentials). Sandboxes don't talk to Firebase, so this is rare. Only relevant if your tests also exercise live Rules Test API verification (`@pyric/cli/credentials/node`) or other live-cloud surfaces.
- **Shared output streams**. Log noise from one test can confuse another's assertions if both subscribe to the same console. Subscribers are per-sandbox, so this doesn't happen automatically; only worry about it if you wire global logging.

## What `reset` does *not* do

- It does not re-run any seed function you may have defined.
- It does not re-deploy rules. After `reset`, the sandbox is in default-deny.
- It does not invalidate `SandboxContext` references. They keep working.
- It does not affect any other sandbox you might have constructed.

## Where to look next

- For seeding data and rules after reset, see [Seed initial data and rules](./seed-data-and-rules.md).
- For why `dispose` and `reset` are separate, see [Listener re-evaluation on `deployRules`](../explanation/listener-re-evaluation.md).
