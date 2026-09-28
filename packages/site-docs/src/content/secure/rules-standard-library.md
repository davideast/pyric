---
title: "Use tested modules in Firestore Security Rules"
navLabel: "The rules standard library"
group: "Secure & debug"
section: ""
order: 50
description: "Import a tested rule function, resolve it to ordinary Firebase Rules, then lint and simulate the result."
---

# Use tested modules in Firestore Security Rules

This guide uses the Firestore-compatible part of Pyric's tested Rules standard library, plus the Storage module `storage/objects`. The catalog is service-aware: `auth` and `membership` work in Firestore and Storage, `storage/*` modules are Storage-only, and the remaining modules are Firestore-only. See the [service-aware module reference](../trust/rules-standard-library.md) for the complete catalog. The `2+modules` source format adds imports for local development; the resolver replaces those imports with ordinary `rules_version = '2'` functions before deployment.

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
| `lifecycle` | Immutable or changed fields and server timestamps | `fieldUnchanged`, `immutableFields`, `isServerTimestamp`, `onlyFieldsChanged`, `exactlyChanged`, `nFieldsChanged` |
| `content` | Author-owned documents, published visibility, and hidden per-player documents | `validAuthorCreate`, `isAuthor`, `canReadContent`, `notDeleted`, `ownerOnlyUntil` |
| `membership` | Claims and document membership maps | `hasClaim`, `hasClaimRole`, `isMemberOf`, `hasRole` |
| `spaces` | Parent-document membership for child data | `isSpaceMember`, `hasSpaceRole`, `validMemberCreate` |
| `joining` | Safe self-service join and leave | `onlyAddedSelf`, `onlyRemovedSelf` |
| `transitions` | Allowed state-machine edges | `validTransition`, `statusIs`, `newStatusIs` |
| `counters` | Bounded values, controlled numeric changes, and best scores | `incrementedBy`, `changedBy`, `boundedNumber`, `improvedBy` |
| `timing` | Update cooldowns | `cooldownElapsed` |
| `atomic` | Companion changes in one batch | `companionChangedBy`, `consumedFlag` |
| `geometry` | Config-driven game moves and named board squares | `validSimpleMove`, `validJumpMove`, `file`, `rank`, `step`, `inBounds` |
| `lobby` | Two-player session creation, joining, and rematches | `validCreate`, `validJoin`, `canCancel`, `validRematch` |
| `turns` | Turn enforcement for two seats or a seat list | `isMyTurn`, `turnFlipped`, `isSeatTurn`, `turnAdvanced` |
| `state` | Game status, move count, and participants | `isPlaying`, `moveIncremented`, `participantsUnchanged` |
| `results` | Resigning, finishing, and keeping a game result | `resignedBy`, `finishedWithWinner`, `resultUnchanged` |
| `fairness` | Commit-reveal checks and values derived from a digest | `commitmentMatches`, `digestByte` |

The game-oriented modules assume the field conventions documented by their function descriptions. Prefer the general modules for application data unless your schema matches those conventions.

`validRematch(previousPath)` opens a new match as a rematch of a finished one. You build the path to the finished match, and the function reads it with one `get()`:

- The finished match has status `'won'`, `'draw'` or `'resigned'`, and it seated the caller as host or guest.
- The new match opens like any other lobby: the caller is host, `guest` is `''`, and `status` is `'waiting'`. Either seat can ask, so the seats swap when the guest asks.
- The other player takes the open seat through `validJoin`, which does not check that they played the finished match.
- A missing finished match is an error, so the function denies the request.

```rules
rules_version = '2+modules';

import { validCreate, validRematch } from 'lobby';

service cloud.firestore {
  match /databases/{database}/documents {
    match /matches/{matchId} {
      allow create: if !('rematchOf' in request.resource.data) && validCreate();
      allow create: if validRematch(/databases/$(database)/documents/matches/$(request.resource.data.rematchOf));
    }
  }
}
```

`ownerOnlyUntil(parentPath, ownerUid, statuses)` in `content` hides a per-player document, such as a fleet or a hand, from the other players until the match ends:

- The document lives under its match at `{collection}/{matchId}/{sub}/{uid}`. Pass the `uid` wildcard as the owner when the document id is the owner's UID, or `resource.data.<field>` when the owner is a field.
- The owner reads the document at any time. Any other signed-in caller reads it once the match's `status` is in `statuses`. Pass one status as a one-item list, such as `['finished']`.
- The owner check runs before the `get()` of the match, so the owner's read spends no read. Everyone else pays one `get()`.
- A missing match is an error, so the function denies every caller but the owner.

```rules
rules_version = '2+modules';

import { ownerOnlyUntil } from 'content';

service cloud.firestore {
  match /databases/{database}/documents {
    match /battleship/{matchId}/boards/{uid} {
      allow get: if ownerOnlyUntil(
        /databases/$(database)/documents/battleship/$(matchId), uid, ['won', 'resigned']);
    }
  }
}
```

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

`lifecycle` has two checks on the set of top-level fields a write adds, removes, or changes:

- `onlyFieldsChanged(keys)`: the changed fields are a subset of `keys`. A listed field may stay unchanged.
- `exactlyChanged(keys)`: the changed fields equal `keys`. Every listed field changes and no other field does.

Use `exactlyChanged` when a transition always writes the same fields. A tic-tac-toe move always changes `board`, `lastMove`, `currentTurn`, and `moveCount`, and a plain move never changes `status` or `winner`:
```rules
allow update: if request.resource.data.status == 'playing'
  && exactlyChanged(['board', 'lastMove', 'currentTurn', 'moveCount']);
```
`keys` can be a list or a set. Both functions read `resource.data`, so call them from update rules only: on create the call is an error and the rule denies.

`counters` has `improvedBy(field, direction, mayChange)` for a best score that only gets better. It allows an update when `field` moves strictly `'up'` or `'down'` and every other changed top-level field is in `mayChange`:
```rules
allow update: if isOwner(resource.data.uid)
  && improvedBy('score', 'up', ['solve', 'updatedAt']);
```
Read the result this way:

- An unchanged score, a worse score, and a direction other than `'up'` or `'down'` deny.
- The old and the new value must each be an int or a float. They compare by value, so `10.5` is up from `10`. A string or a missing value on either side denies.
- A field in `mayChange` may stay unchanged. Any other field added, removed, or changed denies.
- `improvedBy` compares only the old and new values. Write the score's type, bounds, and owner checks beside it.

For a score ranked on two fields, such as fewest moves and then fewest pushes, call `improvedBy` once per field:
```rules
allow update: if improvedBy('moves', 'down', ['pushes', 'solve'])
  || improvedBy('pushes', 'down', ['solve']);
```
The second call leaves `moves` out of `mayChange`, so it allows fewer pushes only on as many moves. `improvedBy` reads `resource.data`, so call it from update rules only.

`geometry` has four functions for a board keyed by square names such as `'e4'`, on an 8 by 8 board. A square is a file letter `'a'` to `'h'` followed by a rank digit `'1'` to `'8'`:

- `file(square)`: the file as a number, `'a'` is 1 and `'h'` is 8.
- `rank(square)`: the rank as a number.
- `step(square, df, dr)`: the square `df` files and `dr` ranks away, as a name.
- `inBounds(square)`: the value is a string that names a square of the board.

A checkers man moves one square diagonally forward:
```rules
allow update: if inBounds(request.resource.data.to)
  && (request.resource.data.to == step(resource.data.from, 1, 1)
      || request.resource.data.to == step(resource.data.from, -1, 1));
```
Read the result this way:

- `file`, `rank`, and `step` read a square; they don't check it. A malformed square is an error, and the rule denies.
- `rank` reads only the second character, so `rank('e9')` is 9 and `rank('e44')` is 4. Call `inBounds` on a square the client wrote before you trust it.
- A step off the board in any direction is an error. Inside `||`, a true operand still allows, so a step off one edge doesn't deny a move toward the other.
- `inBounds` is false, not an error, for anything that isn't a square, a non-string included.

Each function costs what the same check costs when you write it inline:

| Check | With `geometry` | Written inline |
|---|---|---|
| File of a square | `file`: 23 | map lookup on `sq[0:1]`: 23 |
| Rank of a square | `rank`: 6 | `int(sq[1:2])`: 6 |
| `to` is `df` files and `dr` ranks from `from` | `step(from, df, dr) == to`: 51 | file and rank differences: 53 to 71 |
| Square is on the board | `inBounds`: 5 to 9 | range check on an int cell: 6 to 14 |

To test that `to` is any one diagonal neighbor of `from`, compare `file` and `rank` differences, which costs 73 to 145. Four `step` calls cost more than 200 when none of them match.

A board keyed by rank and file digits, such as `'34'` for rank 3 and file 4, needs none of these: `string(int(sq) + 10 * dr + df)` is the step.

## Check Storage objects by name

Storage rules import the `storage/*` modules the same way. `storage/objects` reads the object name, the object's full path within the bucket:

- `nameSegment(index)` returns one segment of the name split on `/`, counting from 0. An index past the last segment is an error, so the function denies the request.
- `matchesDocument(path, field)` checks that the caller is signed in, that the Firestore document at `path` exists, and that its `field` equals the object name. A missing document or field denies the request.

On create and update the name comes from `request.resource.name`, because a create may have no stored object yet. On get and delete it comes from `resource.name`, because those requests carry no incoming object.

```rules
rules_version = '2+modules';

import { nameSegment, matchesDocument } from 'storage/objects';

service firebase.storage {
  match /b/{bucket}/o {
    // The user named in the second segment reads every object below it.
    match /scores/{allPaths=**} {
      allow get: if nameSegment(1) == request.auth.uid;
    }
    // An upload is allowed once the score document names it in `object`.
    match /scores/{uid}/{level}/{file} {
      allow create: if matchesDocument(
        /databases/(default)/documents/levels/$(level)/scores/$(uid), 'object');
    }
  }
}
```

Each `matchesDocument` call reads one document from the (default) database. A Storage rule reads at most two distinct Firestore documents, so call it at most twice with different paths; a third distinct document denies the request. Calling it again with the same path reads the same document and does not count twice.

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
