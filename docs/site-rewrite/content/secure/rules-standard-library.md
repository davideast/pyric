---
title: The Firestore rules standard library
navLabel: The rules standard library
outcome: Compose security rules from tested modules, with an import system that compiles away before Firebase ever sees it.
status: draft
---

# The Firestore rules standard library

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

The rules language has no import statement. This file deploys anyway. `isMyTurn` and `turnFlipped` are not snippets you pasted from somewhere. They are functions from Pyric's rules standard library, fifteen modules of common and advanced security checks, each with tests, pulled in by name.

## An import system that compiles away

Declare `rules_version = '2+modules'` instead of `'2'` and the import syntax becomes legal. Imports resolve to flat names, so you call the function directly, never through a module prefix:

```rules
rules_version = '2+modules';
import { hasClaim } from 'membership';
import { statusIs } from 'transitions';

// hasClaim(...), never membership.hasClaim(...)
allow update: if hasClaim('moderator') && statusIs('status', 'pending');
```

When you lint, simulate, or deploy, the resolver:

- pulls in the functions you named, plus anything they call
- prefixes each module's private helpers with the module name, so two modules can never collide
- orders dependencies before dependents and injects the result into your ruleset
- rewrites the version back to `'2'`

The output is stock Firestore rules. Firebase never sees the module system. And if an imported name collides with a function your file already defines, resolution fails loudly instead of shadowing anything.

## Fifteen modules, common to advanced

Any file can mix modules, so a game rule borrows from `counters` as naturally as from `state`:

```rules
import { isPlaying } from 'state';
import { incrementedBy } from 'counters';

allow update: if isPlaying() && incrementedBy('moveCount', 1);
```

| Module | What it covers |
|---|---|
| `auth` | signed-in and ownership checks, the two every app writes first |
| `validation` | field shape: required keys, allowed keys, string sizes, enums |
| `lifecycle` | immutable fields, server timestamps, "these fields and nothing else" |
| `content` | author-owned documents with draft visibility and soft delete |
| `membership` | roles from custom claims or a members map |
| `transitions` | state machines: exactly which edge a write may traverse |
| `counters` | numbers that only move by known steps or stay in bounds |
| `timing` | cooldowns: the stored timestamp must be older than the window |
| `spaces` | parent-document membership gating for teams, rooms, projects |
| `joining` | self-service join and leave with no privilege escalation |
| `atomic` | cross-document integrity inside a single batch write |
| `lobby` | create, join, cancel for host and guest session documents |
| `turns` | turn order for two-player games |
| `state` | status checks, move counting, participants unchanged |
| `geometry` | movement validation against a config document you pass in |

Every module ships with an executable fixture file beside it, and `stdlib-cases.test.ts` runs each case through the real resolver and the rules simulator, asserting the exact verdict, allow or deny. A case the simulator cannot decide fails the suite outright. So the modules are simulator-tested with executable fixtures, not example code that happens to live in a repo.

## The everyday pair: auth and validation

Most rulesets start with the same two questions, who is writing and what are they writing. `auth` answers the first, `validation` the second:

```rules
rules_version = '2+modules';
import { isAuthenticated, isOwner } from 'auth';
import { hasRequired, hasOnly, validString, isOneOf } from 'validation';

service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{userId} {
      allow read: if isAuthenticated();
      allow write: if isOwner(userId)
        && hasRequired(['displayName', 'visibility'])
        && hasOnly(['displayName', 'visibility', 'bio'])
        && validString('displayName', 1, 50)
        && isOneOf('visibility', ['public', 'private']);
    }
  }
}
```

Read it back: only the owner writes, both required fields are present, nothing beyond the three allowed keys, the name is 1 to 50 characters, and visibility is one of two values. The details carry the hard-won parts. `validString` reads the field with bracket access, so a missing field fails the check instead of erroring, and `isOneOf` uses `in` on a list because `.includes()` does not exist in rules.

## Let users join a team, and only as themselves

The advanced end of the shelf: a map-shaped `members` field on a team document, where users join and leave on their own, with no backend granting access and no way to escalate:

```rules
rules_version = '2+modules';
import { onlyAddedSelf, onlyRemovedSelf } from 'joining';
import { onlyFieldsChanged } from 'lifecycle';

service cloud.firestore {
  match /databases/{database}/documents {
    match /teams/{teamId} {
      allow update: if onlyFieldsChanged(['members'])
        && (onlyAddedSelf('members', 'editor') || onlyRemovedSelf('members'));
    }
  }
}
```

`onlyAddedSelf` diffs the members map and demands set equality: the write adds exactly the caller, at exactly `editor`, changes nobody, removes nobody. A join that also sneaks in a friend, edits an existing role, or self-assigns `admin` denies. Composed with `onlyFieldsChanged(['members'])`, the write cannot touch anything else on the document either.

The fixtures assert each of those denials by name. That is the point of importing over pasting: the failure cases you would not have thought to test are already cases.

## Load stdlib modules into an agent's context

An agent writing rules does not memorize this catalog. It calls `firestore_rules_stdlib_list()` for the module keys, then `firestore_rules_stdlib_get({ key: 'joining' })` for that module's signatures, examples, and common-mistake notes, so the library doubles as context that teaches the agent the same habit this page teaches you. The playground enforces it too: an invented function name fails compile, an imported one resolves. See [skills](../agent/skills.md).

## Where to go next

Every signature, with parameters and gotchas, is in the [module reference](../../../../packages/pyric/docs/rules/reference/stdlib-modules.md). The techniques the modules are built from are yours to use directly, in [rules patterns](../secure/rules-patterns.md).
