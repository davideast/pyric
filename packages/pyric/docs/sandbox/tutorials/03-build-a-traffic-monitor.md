# Build a traffic monitor

Build a tiny event monitor over the sandbox. You'll subscribe to `sandbox.onEvent`, see allowed and denied operations stream through, watch listener attaches and snapshot deliveries fire on the same channel, then filter the stream by `kind`. By the end you'll have run a working monitor against a real sandbox and felt the unified event shape through your fingers.

This tutorial assumes you've completed [Your first sandbox session](./01-your-first-sandbox-session.md) and have `pyric/sandbox` + `pyric-admin` installed.

## What you will build

A standalone script that prints a live, terminal-friendly event log:

```
[#1] listener_attach query notes by alice
[#2] snapshot_delivery query notes (+0 ~0 -0) size=0 by alice
[#3] request    allow set    notes/n1  by alice  1.1ms
[#4] write      set    notes/n1  by alice  (was: null)
[#5] snapshot_delivery query notes (+1 ~0 -0) size=1 by alice  ⇨ triggered by set notes/n1
[#6] request    allow get    notes/n1  by alice  0.5ms
[#7] request    deny   get    notes/n1  by bob    0.4ms  ⇨ Rule #0 (read,write) → deny
[#8] listener_detach query notes by alice
[#9] session_boundary phase=dispose priorOpCount=8
```

No Firebase project, no network, no UI framework. ~70 lines of code total.

## Step 1: Set up

```bash
mkdir traffic-tutorial && cd traffic-tutorial
bun init -y
bun add pyric/sandbox pyric-admin
```

Create `monitor.ts`.

## Step 2: Subscribe before anything happens

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';
import type { SandboxEvent } from 'pyric/sandbox';

const sandbox = initializeSandbox();

let seq = 0;
function print(ev: SandboxEvent) {
  seq++;
  const tag = `[#${seq}]`;
  const who = (uidOf(ev) ?? 'null').padEnd(6);
  switch (ev.kind) {
    case 'request': {
      const result = ev.result.padEnd(5);
      const method = ev.method.padEnd(6);
      const path = ev.path.padEnd(20);
      const ms = `${ev.evalMs.toFixed(1)}ms`.padEnd(6);
      const reason = ev.result === 'deny'
        ? `  ⇨ ${ev.reasons.find((r) => /→ deny/.test(r)) ?? 'denied'}`
        : '';
      console.log(`${tag} request    ${result} ${method} ${path} by ${who} ${ms}${reason}`);
      break;
    }
    case 'write': {
      const method = ev.method.padEnd(6);
      const path = ev.path.padEnd(20);
      const prior = ev.priorState === null ? 'null' : 'present';
      console.log(`${tag} write      ${method} ${path} by ${who}  (was: ${prior})`);
      break;
    }
    case 'snapshot_delivery': {
      const target = ev.target.kind === 'doc' ? ev.target.path : ev.target.collection;
      const trig = ev.triggeredBy ? `  ⇨ triggered by ${ev.triggeredBy.method} ${ev.triggeredBy.path}` : '';
      console.log(`${tag} snapshot_delivery ${ev.target.kind} ${target} (+${ev.addedCount} ~${ev.modifiedCount} -${ev.removedCount}) size=${ev.size} by ${who}${trig}`);
      break;
    }
    case 'snapshot_suppressed': {
      const target = ev.target.kind === 'doc' ? ev.target.path : ev.target.collection;
      console.log(`${tag} snapshot_suppressed ${ev.target.kind} ${target} by ${who} (no-op)`);
      break;
    }
    case 'listener_attach':
    case 'listener_detach':
    case 'listener_errored': {
      const target = ev.target.kind === 'doc' ? ev.target.path : ev.target.collection;
      console.log(`${tag} ${ev.kind} ${ev.target.kind} ${target} by ${who}`);
      break;
    }
    case 'session_boundary': {
      console.log(`${tag} session_boundary phase=${ev.phase} priorOpCount=${ev.priorOpCount}`);
      break;
    }
  }
}

function uidOf(ev: SandboxEvent): string | null {
  if (ev.kind === 'session_boundary') return null;
  return ev.auth?.uid ?? null;
}

sandbox.onEvent(print);
console.log('subscribed.');
```

Run it now: `bun run monitor.ts`. You'll see one line:

```
subscribed.
```

The subscription is live, but nothing is happening yet. That's the point. `onEvent` is purely an observation channel; subscribing doesn't cause work, it attaches a listener and waits.

## Step 3: Make some traffic

Append to `monitor.ts`:

```ts
const alice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bob = getFirestore(sandbox.withAuth({ uid: 'bob' }));

alice.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`);

// Attach a query listener before the first write so the initial-fire
// delivery surfaces in the event log.
const unsub = alice.collection('notes').onSnapshot(() => {});

await alice.collection('notes').doc('n1').set({ body: 'hello' });
await alice.collection('notes').doc('n1').get();
try {
  await bob.collection('notes').doc('n1').get();
} catch { /* expected */ }

unsub();
sandbox.dispose();
```

Re-run: `bun run monitor.ts`. You'll see something like:

```
subscribed.
[#1] listener_attach query notes by alice
[#2] snapshot_delivery query notes (+0 ~0 -0) size=0 by alice
[#3] request    allow set    notes/n1  by alice  1.4ms
[#4] write      set    notes/n1  by alice  (was: null)
[#5] snapshot_delivery query notes (+1 ~0 -0) size=1 by alice  ⇨ triggered by set notes/n1
[#6] request    allow get    notes/n1  by alice  0.3ms
[#7] request    deny   get    notes/n1  by bob    0.2ms  ⇨ Rule #0 (read,write) → deny
[#8] listener_detach query notes by alice
[#9] session_boundary phase=dispose priorOpCount=8
```

Every observable thing that happened, from listener attach through the per-op rules eval through committed writes through snapshot delivery through teardown, flowed through one subscription.

## Step 4: Filter by kind

The unified channel is great for "see everything", but most consumers want a slice. Replace `sandbox.onEvent(print)` with a filtered subscription:

```ts
// Just denials — same shape as the old onDenial channel.
sandbox.onEvent((ev) => {
  if (ev.kind === 'request' && ev.result === 'deny') print(ev);
});
```

Re-run. The only events that print are denials. Try other filters:

- `ev.kind === 'snapshot_delivery'`: only the deliveries hitting the user callback.
- `ev.kind === 'request' && ev.origin === 'user'`: user-initiated requests only, no listener re-evals.
- `ev.kind === 'write'`: every committed write, with `priorState`/`nextState` for diff rendering.

## Step 5: Survive a reset

The subscription stays attached across `sandbox.reset()`. Replace the script's tail with:

```ts
await alice.collection('notes').doc('n1').set({ body: 'before' });
sandbox.reset();
// Rules wiped; redeploy + write again. The subscription still works.
getFirestore(sandbox.withAuth({ uid: 'alice' })).setRules(`rules_version = '2';
service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }`);
await getFirestore(sandbox.withAuth({ uid: 'alice' })).collection('notes').doc('n2').set({ body: 'after' });
sandbox.dispose();
```

Re-run. You'll see:

```
... events from the pre-reset write ...
session_boundary phase=reset priorOpCount=N
... events from the post-reset write ...
session_boundary phase=dispose priorOpCount=M
```

The `session_boundary` event fires before the underlying env swaps. Consumers persisting the event stream segment their log on those boundaries.

## What you built

- Subscribed to `onEvent` and received six distinct kinds of events.
- Filtered by kind to recover the older per-channel slices (denials, snapshot errors).
- Observed listener lifecycle, snapshot deliveries, and session boundaries: surfaces the prior three-channel API didn't expose.

## Next steps

- The [`SandboxEvent` reference](../reference/sandbox-event.md) for the full field list per kind.
- The [Observe sandbox events how-to](../how-to/observe-events.md) for the subscriber contract, hot-path discipline, and the filter cookbook.
- The [design explanation](../explanation/every-op-is-a-request.md) for why this channel collapsed three predecessor channels into one.
