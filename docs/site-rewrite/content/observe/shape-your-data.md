---
title: Seed, snapshot, reset, and replay the backend like source
navLabel: Seed, snapshot, replay
outcome: Put the backend in any state you want, capture the good ones, and get them back on demand.
status: draft
---

# Seed, snapshot, reset, and replay the backend like source

Your backend is local state. That changes what you can do with it. You can seed a scenario, snapshot the moment it looks right, commit that file, wipe everything between tests, and replay a whole session later to see if it still holds. The same moves you make on source code, on your data.

## Seed a scenario

The fastest path is a fixture file served at startup:

```bash
pyric dev --seed fixtures/onboarding.json
```

A fixture carries documents and auth users, so the app opens onto a populated backend with people already signed up. The seed applies only into an empty sandbox; if earlier data exists, it is skipped and a console line says why.

In tests, seed in code. Rules first, then documents, because writes before rules evaluate against default-deny:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));

adminDb.setRules(RULES);
await adminDb.collection('notes').doc('n1').set({ ownerId: 'alice', title: 'first note' });
```

## Snapshot the moment it looks right

You've been working interactively: signing in test users, creating documents, getting the data into exactly the shape you want. Don't rebuild that by hand. Promote it:

```bash
pyric dev --persist        # work in the app; state persists as you go
pyric snapshot --out fixtures/onboarding.json
```

`pyric snapshot` reads the live dev server and writes a committable fixture with both documents and users. Passwords are redacted by default, so the file is safe to commit, and the redaction round-trips: re-served users still sign in through the helper. Commit it, and everyone on the team, plus CI, starts from the same place:

```bash
pyric dev --seed fixtures/onboarding.json
```

## Reset between tests

`sandbox.reset()` wipes documents, rules, and listeners, but the sandbox object and every context derived from it keep working. So hoist one sandbox to the top of the file and reset before each case:

```ts
beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
  // re-seed whatever the next test needs
});
```

After reset the sandbox is empty and in default-deny. Nothing is re-run for you: re-deploy rules and re-seed in the hook. `onEvent` subscriptions survive the reset, so a monitor attached in `beforeAll` keeps watching.

## Switch users mid-session

Identity is a context, and contexts are cheap. Derive one per user and evaluate the same data as different people:

```ts
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const anonDb  = getFirestore(sandbox.withAuth(null));
const editor  = getFirestore(sandbox.withAuth({ uid: 'em-42', token: { role: 'editor' } }));
```

Writes through `aliceDb` evaluate with `request.auth.uid == 'alice'`. The `token` object becomes `request.auth.token.*` in rules, so custom claims are one field away. Anonymous is explicit: `withAuth(null)`, never `undefined`.

## Replay a captured session

While you work, `pyric dev` records the session to `.pyric/last-session.json` by default: every write, with its real identity, real server timestamps, real auto-ids. A replay re-issues those writes against a fresh sandbox and a candidate ruleset and reports what changed:

```bash
pyric verify --rules firestore=firestore.rules
```

That recording is a rules regression suite you didn't write. It knows a re-resolved `serverTimestamp()` is not a change, and a freshly minted auto-id is not a change, so what surfaces is the signal: the operation that used to be allowed and now is not.

The place this pays off is the deploy gate, where the same replay runs against the rules you're about to ship. See [Ship to production](../ship/ship-to-production.md). You can also replay in code with `sandbox.history()` and `replay(events, rules)` when you want the divergence list programmatically.

## And from an agent

Seed, reset, and snapshot are tools on the same MCP surface your editor connects to, so an agent can stand up a scenario, run its checks, and reset to a clean slate without your help. For scratch work it can open a stateful simulator session with its own undo stack, and `sandbox_inspect` tells it what state it's actually in. See [Set up your agent](../agent/set-up-your-agent.md).

## Where to go next

Watch the state you're shaping move through the system in [See what's happening](./see-whats-happening.md), or take a captured session to the deploy gate in [Ship to production](../ship/ship-to-production.md).
