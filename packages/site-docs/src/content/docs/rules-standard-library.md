---
title: "Build your rules from tested parts"
navLabel: "The rules standard library"
group: "Secure & debug"
section: ""
order: 13
description: "Compose security rules from tested modules, with an import system that compiles away before Firebase ever sees it."
---

# Build your rules from tested parts

This is a Firestore rules file:
```rules
rules_version = '2+modules';
import { isMyTurn, turnFlipped } from 'turns';

service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      allow update: if isMyTurn() && turnFlipped();
    }
  }
}
```
The rules language has no import statement. This file deploys anyway, and what lands on Firebase is stock `rules_version = '2'` with the two functions inlined at the top of the match tree. `isMyTurn` and `turnFlipped` are not snippets you pasted. They are functions from a tested module, pulled in by name.

## An import system that compiles away

Declare `rules_version = '2+modules'` instead of `'2'` and the import syntax becomes legal. When you lint, simulate, or deploy, the resolver:

- reads each import and pulls in the functions you named, plus anything they call
- prefixes each module's private helpers with the module name, so two modules can never collide
- orders dependencies before dependents and injects the result into your ruleset
- rewrites the version back to `'2'`

The output is byte-valid stock Firestore rules. Firebase never sees the module system.

Two things to know once you are inside it:

- Imports resolve to flat names. You call `hasRequired([...])`, never `validation.hasRequired(...)`.
- If an imported function collides with one your file already defines, resolution fails loudly instead of shadowing anything.

## Rate limits, atomic pairs, and state machines

Fifteen modules ship with Pyric. A few exist specifically because the received wisdom says they can't.

**Rules can rate-limit.** `timing.cooldownElapsed('lastMoveAt', 2)` allows an update only when the stored timestamp is more than two seconds old. On its own that is forgeable, because the client writes the timestamp and could write one from last week. So pair it with `isServerTimestamp('lastMoveAt')` from `lifecycle` on the same write, which forces the field to be the server's own clock:
```rules
import { cooldownElapsed } from 'timing';
import { isServerTimestamp } from 'lifecycle';

// At most one move every 2 seconds
allow update: if cooldownElapsed('lastMoveAt', 2)
  && isServerTimestamp('lastMoveAt');
```
A missing or non-timestamp field errors, and an error denies. Verified against the production rules engine, not a simulation of it.

**Rules can enforce integrity across a batch.** The `atomic` module uses the `get()`/`getAfter()` pair, where `getAfter()` reads another document as it will be after the current batch commits. `companionChangedBy(before, after, 'taskCount', 1)` allows a write only if a companion document's counter moved by exactly one in the same batch.

A solo write denies by construction: outside a batch, `getAfter()` equals `get()`, so the delta is zero. `consumedFlag` handles single-use invites the same way, pre-batch false and post-batch true, so a replay of the consuming write denies.

Live-verified against a real production database, rules deployed and batch commits issued as a signed-in user. One thing to remember: every write in a batch is evaluated, so the companion write needs its own allow rule.

**Rules can be a state machine.** `transitions.validTransition('status', 'pending', 'paid')` names exactly which edge a write may traverse, and nothing else.

**Membership can change safely with no backend.** `spaces` gates a subcollection through its parent document's members field, list-shaped or map-shaped, and fails closed when the field or the parent document is missing.

`joining` covers the write side. `onlyAddedSelf('members', 'editor')` uses set equality on the map diff, so the write adds exactly the caller at exactly that role. Nobody else changed, nobody removed, no self-granted admin.

Compose it with `lifecycle.onlyFieldsChanged(['members'])` and a join cannot touch anything else on the document. Production-verified, ten scenarios of ten.

One gotcha worth taking from `membership` even if you never import it: custom claims live at `request.auth.token.admin`, not `request.auth.admin`. The second form reads null and quietly denies forever.

## The everyday modules

The rest of the shelf covers the common shapes.

| Module | What it covers |
|---|---|
| `auth` | the two checks every app writes first |
| `validation` | field shape and enum checks |
| `lifecycle` | `onlyFieldsChanged`, the single most common update guard: users may edit these fields and nothing else |
| `content` | author-owned documents with draft visibility and soft delete |
| `counters` | client-maintained numbers that may only change by known steps |
| `lobby`, `turns`, `state`, `geometry` | the game set the case studies are built from |

Every module ships with test fixtures that execute against the rules engine in CI, and each case must decide allow or deny as expected. The modules making the boldest claims, `timing`, `atomic`, `spaces`, `joining`, and `geometry`, are verified against production Firebase as well.

This page is a guide, not the catalog. The full module list, every signature with its gotchas, lives in the module manifest until the reference section lands.

## And from an agent

An agent does not memorize any of this. `firestore_rules_stdlib_get({ key: 'timing' })` returns a module's signatures, examples, and gotchas, and the resolver runs in-process, so the agent composes a ruleset from modules, lints it, and simulates verdicts before anything deploys. See [skills](../skills/).

## Where to go next

The modules are built from techniques you can use directly, in [rules patterns](../rules-patterns/). To prove a composed ruleset behaves before it ships, go to [simulate and lint before you deploy](../simulate-and-lint/).
