---
title: "Use tested modules in Firestore Security Rules"
navLabel: "The rules standard library"
group: "Secure & debug"
section: ""
order: 50
description: "Import a tested rule function, resolve it to ordinary Firebase Rules, then lint and simulate the result."
---

# Use tested modules in Firestore Security Rules

This guide uses the Firestore-compatible part of Pyric's tested Rules standard library. The catalog is service-aware: `auth` and `membership` work in Firestore and Storage, `storage/*` modules are Storage-only, and the remaining modules are Firestore-only. See the [service-aware module reference](../trust/rules-standard-library.md) for the complete catalog. The `2+modules` source format adds imports for local development; the resolver replaces those imports with ordinary `rules_version = '2'` functions before deployment.

This example lets an author update a post, prevents changes to `authorId` and `createdAt`, and requires a two-second cooldown between edits.

## Import the functions you need

Create `firestore.modules.rules`:
```rules
rules_version = '2+modules';

import { isAuthor } from 'content';
import { onlyFieldsChanged, isServerTimestamp } from 'lifecycle';
import { cooldownElapsed } from 'timing';

service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow update: if isAuthor('authorId')
        && onlyFieldsChanged(['title', 'body', 'updatedAt'])
        && cooldownElapsed('updatedAt', 2)
        && isServerTimestamp('updatedAt');
    }
  }
}
```
Imports are flat: call `isAuthor(...)`, not `content.isAuthor(...)`. Resolution fails if an imported name collides with a function already declared in your file.

`cooldownElapsed('updatedAt', 2)` compares the stored timestamp with `request.time`. Pairing it with `isServerTimestamp('updatedAt')` matters: without that second check, a client could submit an old timestamp and bypass the next cooldown. `cooldownElapsed` is for updates because it reads `resource.data`.

## Split your own rules into modules

A file of your own can hold functions for one part of the app and import what it calls, the same way the main file does. Put `rules_version = '2+modules';` and the imports before the first function, and mark the functions other files use with `export`:
```rules
// games/tictactoe.rules
rules_version = '2+modules';

import { validCreate } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';

export function ticTacToeCreate() {
  return validCreate() && request.resource.data.moveCount == 0;
}

export function ticTacToeMove() {
  return isMyTurn() && turnFlipped();
}
```
Import it from the main file with a relative path:
```rules
// firestore.modules.rules
rules_version = '2+modules';

import { ticTacToeCreate, ticTacToeMove } from './games/tictactoe';

service cloud.firestore {
  match /databases/{database}/documents {
    match /tictactoe/{matchId} {
      allow create: if ticTacToeCreate();
      allow update: if ticTacToeMove();
    }
  }
}
```
A relative import inside a module resolves from that module's directory. Each module is included once, however many files import it. A module can call its own functions, the functions it imports, and the functions the main file imports; any other call to another module's function is rejected.

## Resolve to deployable Rules

Firebase does not understand `2+modules`, so compile the imports away:
```bash
pyric firestore rules resolve firestore.modules.rules --out firestore.rules
```
The generated `firestore.rules` contains `rules_version = '2'` and the imported function bodies. Point `firebase.json` at that generated file, and commit both the module source and resolved output if production deploys from the repository.

## Lint and simulate the resolved result
```bash
pyric rules lint --service firestore
```
You can then exercise the rule through the public API:
```ts
import { readFileSync } from 'node:fs';
import { firestoreRules } from 'pyric/rules';

const source = readFileSync('firestore.rules', 'utf8');
const result = firestoreRules(source).simulate([
  {
    description: 'author changes the title after the cooldown',
    expectation: 'ALLOW',
    method: 'update',
    path: 'posts/p1',
    auth: { uid: 'alice' },
    requestTime: '2026-07-16T12:00:03.000Z',
    resource: {
      authorId: 'alice',
      title: 'Old',
      body: 'Text',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    data: {
      authorId: 'alice',
      title: 'New',
      body: 'Text',
      updatedAt: '2026-07-16T12:00:03.000Z',
    },
  },
]);

if (result.failed > 0 || result.unsupported > 0) process.exit(1);
```
Pin `requestTime` whenever a rule reads `request.time`, otherwise the test depends on the clock.

## Choose a module

These are the Firestore-compatible modules used by this guide. The [complete reference](../trust/rules-standard-library.md) also covers common and Storage-only modules.

| Module | Use it for | Main functions |
|---|---|---|
| `auth` | Authentication and ownership | `isAuthenticated`, `isOwner` |
| `validation` | Required fields, allowed fields, strings, enums | `hasRequired`, `hasOnly`, `validString`, `isOneOf` |
| `lifecycle` | Immutable or changed fields and server timestamps | `fieldUnchanged`, `immutableFields`, `isServerTimestamp`, `onlyFieldsChanged`, `nFieldsChanged` |
| `content` | Author-owned documents and published visibility | `validAuthorCreate`, `isAuthor`, `canReadContent`, `notDeleted` |
| `membership` | Claims and document membership maps | `hasClaim`, `hasClaimRole`, `isMemberOf`, `hasRole` |
| `spaces` | Parent-document membership for child data | `isSpaceMember`, `hasSpaceRole`, `validMemberCreate` |
| `joining` | Safe self-service join and leave | `onlyAddedSelf`, `onlyRemovedSelf` |
| `transitions` | Allowed state-machine edges | `validTransition`, `statusIs`, `newStatusIs` |
| `counters` | Bounded values and controlled numeric changes | `incrementedBy`, `changedBy`, `boundedNumber` |
| `timing` | Update cooldowns | `cooldownElapsed` |
| `atomic` | Companion changes in one batch | `companionChangedBy`, `consumedFlag` |
| `geometry` | Config-driven game moves | `validSimpleMove`, `validJumpMove` |
| `lobby` | Two-player session creation and joining | `validCreate`, `validJoin`, `canCancel` |
| `turns` | Turn enforcement for two seats or a seat list | `isMyTurn`, `turnFlipped`, `isSeatTurn`, `turnAdvanced` |
| `state` | Game status, move count, and participants | `isPlaying`, `moveIncremented`, `participantsUnchanged` |
| `results` | Resigning, finishing, and keeping a game result | `resignedBy`, `finishedWithWinner`, `resultUnchanged` |

The game-oriented modules assume the field conventions documented by their function descriptions. Prefer the general modules for application data unless your schema matches those conventions.

`turns` covers two document shapes:

- Two seats: `isMyTurn` and `turnFlipped` read `host`, `guest`, and `currentTurn`.
- A seat list of any size: `isSeatTurn` and `turnAdvanced` read `players`, the UIDs in turn order, and `turn`, the int index of the seat on turn.

`isSeatTurn(seats, turnIndex)` takes the list and the index as arguments, so it also works on a document that names them differently. `turnAdvanced(seatCount)` checks that the new `turn` is `(turn + 1) % seatCount`, so the last seat wraps to seat 0, and that `players` is unchanged. `%` on two ints is the remainder, as in production:
```rules
rules_version = '2+modules';

import { isSeatTurn, turnAdvanced } from 'turns';

service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{gameId} {
      allow update: if isSeatTurn(resource.data.players, resource.data.turn)
        && turnAdvanced(resource.data.players.size());
    }
  }
}
```
An index past the last seat, or below 0, is an error, so `isSeatTurn` denies the request.

## Count what each call costs

Production stops evaluating a request when it reaches 1000 expressions and denies it. Every library function states its share of that budget in the comment above it:
```rules
// cost 10 to 57 expressions per call
export function validJoin() {
```
Read the numbers this way:

- The range runs from the cheapest measured path to the most expensive one. `validJoin` costs 10 when the request is unauthenticated and fails at its first check, and 57 when every check runs.
- The cost covers the call, its `let` bindings, and its body. The arguments you pass are extra and cost what they cost wherever you write them.
- The cost is per call. Calls are not memoized, so calling `isOwner` three times in one rule costs three times as much, and a `let` inside a function is paid again on every call.
- A function that reads other documents also states `reads <n>`: the `get()` and `exists()` calls one call can make. Those count against the separate limit on document reads.

The update rule at the top of this guide calls `isAuthor` (6 to 15), `onlyFieldsChanged` (10), `cooldownElapsed` (12), and `isServerTimestamp` (9), so it evaluates at most 46 expressions for those calls plus the `&&` operators and arguments between them.

The numbers are measured, not estimated. Each function is wrapped in a single-rule ruleset, evaluated through the Firebase Rules test endpoint with the requests from its test cases, and padded with an always-false rule of known cost until the request reaches the limit. The smallest padding that reaches it gives the exact count. The module test files hold the same numbers, and the library's tests fail when the comment, the test file, or the linter's static estimate disagree with them.

When you lint a resolved ruleset, each rule that calls the library gets an informational `EXPRESSION_LIBRARY_CALLS` finding. It lists the rule's three most expensive library calls with their cost per call and how many calls the rule makes.

## Look up exact signatures through an agent

Do not ask an agent to guess a helper name. Ask it to inspect the library first:

> Find the standard-library functions for an author-owned post with a server-timestamp cooldown. Show the signatures, compose the rule, resolve it, lint it, and simulate one allowed edit and one too-fast edit.

The agent calls `firestore_rules_stdlib_list`, then `firestore_rules_stdlib_get` for `content`, `lifecycle`, and `timing`. It resolves the source with `firestore_resolve_modules`, checks it with `firestore_lint_rules`, and runs the two cases with `firestore_simulate_rules`.

## Deploy the resolved file

Only deploy the resolved `rules_version = '2'` file:
```bash
firebase deploy --only firestore:rules
```
For the compiler and evaluator ceilings that can still reject a valid-looking ruleset, see [Firestore Rules limits](./firestore-rules-limits.md).
