---
title: "Use tested modules in Firestore Security Rules"
navLabel: "The rules standard library"
group: "Secure & debug"
section: ""
order: 3005
description: "Import a tested rule function, resolve it to ordinary Firebase Rules, then lint and simulate the result."
---

# Use tested modules in Firestore Security Rules

Pyric's standard library is a set of tested Firestore Rules functions. The `2+modules` source format adds imports for local development; the resolver replaces those imports with ordinary `rules_version = '2'` functions before deployment.

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

## Resolve to deployable Rules

Firebase does not understand `2+modules`, so compile the imports away:

```bash
pyric firestore rules resolve firestore.modules.rules --out firestore.rules
```

The generated `firestore.rules` contains `rules_version = '2'` and the imported function bodies. Point `firebase.json` at that generated file, and commit both the module source and resolved output if production deploys from the repository.

## Lint and simulate the resolved result

```bash
pyric firestore rules lint firestore.rules
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

These are the importable modules shipped with Pyric:

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
| `turns` | Two-player turn enforcement | `isMyTurn`, `turnFlipped` |
| `state` | Game status, move count, and participants | `isPlaying`, `moveIncremented`, `participantsUnchanged` |

The game-oriented modules assume the field conventions documented by their function descriptions. Prefer the general modules for application data unless your schema matches those conventions.

## Look up exact signatures through an agent

Do not ask an agent to guess a helper name. Ask it to inspect the library first:

> Find the standard-library functions for an author-owned post with a server-timestamp cooldown. Show the signatures, compose the rule, resolve it, lint it, and simulate one allowed edit and one too-fast edit.

The agent calls `firestore_rules_stdlib_list`, then `firestore_rules_stdlib_get` for `content`, `lifecycle`, and `timing`. It resolves the source with `firestore_resolve_modules`, checks it with `firestore_lint_rules`, and runs the two cases with `firestore_simulate_rules`.

## Deploy the resolved file

Only deploy the resolved `rules_version = '2'` file:

```bash
firebase deploy --only firestore:rules
```

For the compiler and evaluator ceilings that can still reject a valid-looking ruleset, see [Firestore Rules limits](../firestore-rules-limits/).
