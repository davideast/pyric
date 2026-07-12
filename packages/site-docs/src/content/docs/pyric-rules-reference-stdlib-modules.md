---
title: "Standard library modules"
group: "pyric / rules"
section: "Reference"
order: 13016
---
# Standard library modules

Fifteen modules ship with `pyric/rules`. Each module is a `.rules` file living under `src/rules/modules/stdlib/`; imports resolve automatically without any configuration.

Use them by setting `rules_version = '2+modules'` and adding import statements:
```rules
import { isAuthenticated, isOwner } from 'auth';
import { hasOnly } from 'validation';
```
Then run `resolveModules(source)` to inline the exports into a standard `'2'` source. `resolveModules` is an internal engine seam, imported from `pyric/rules/internal/node`, not the public `pyric/rules` front door. See [How to resolve `2+modules` imports](../pyric-rules-how-to-resolve-module-imports/).

Convention: modules either operate against `request` / `resource` / `request.auth` only (self-contained) or take explicit parameters (no implicit lookups).

## `auth`

Access-control primitives.

| Function | Returns |
|---|---|
| `isAuthenticated()` | `request.auth != null` |
| `isOwner(userId)` | `isAuthenticated() && request.auth.uid == userId` |

## `validation`

Document field validation.

| Function | Returns |
|---|---|
| `hasRequired(fields)` | `request.resource.data.keys().hasAll(fields)` |
| `hasOnly(fields)` | `request.resource.data.keys().hasOnly(fields)` |

## `lobby`

Game-session lifecycle. Convention: documents have `host`, `guest`, and `status` fields.

| Function | Returns |
|---|---|
| `validCreate()` | Host is the auth user, guest empty, status is `waiting` |
| `validJoin()` | Guest slot empty, joiner is not host, status flips to `playing` |
| `canCancel()` | Status is `waiting`, requester is host |

## `turns`

Turn enforcement for two-player games. Convention: documents have `host`, `guest`, and `currentTurn` fields.

| Function | Returns |
|---|---|
| `isMyTurn()` | `currentTurn` matches auth uid (host or guest) |
| `turnFlipped()` | `currentTurn` alternates between host and guest |

## `state`

Game-state tracking.

| Function | Returns |
|---|---|
| `isPlaying()` | `resource.data.status == 'playing'` |
| `moveIncremented()` | `moveCount` increased by exactly 1 |
| `participantsUnchanged()` | `host` and `guest` fields unchanged |

## `membership`

Role- and claims-based access control.

| Function | Returns |
|---|---|
| `hasClaim(claim)` | Auth token has non-null value at `claim` |
| `hasClaimRole(claim, role)` | Auth token claim matches the role value |
| `isMemberOf(membersMap)` | Auth uid is a key in the members map |
| `hasRole(membersMap, role)` | Auth uid has the given role in the members map |

## `lifecycle`

Field immutability and timestamp enforcement.

| Function | Returns |
|---|---|
| `fieldUnchanged(field)` | Field value identical before and after the write |
| `immutableFields(fields)` | Every listed field is unchanged (uses MapDiff) |
| `isServerTimestamp(field)` | Field value equals `request.time` |

## `transitions`

State-machine enforcement.

| Function | Returns |
|---|---|
| `validTransition(field, from, to)` | Field transitions from `from` to `to` |
| `statusIs(field, value)` | Pre-write `field` equals `value` |
| `newStatusIs(field, value)` | Post-write `field` equals `value` |

## `geometry`

Movement-game validation via a config-document lookup. The caller must pass the config data (from a `get()` call) as the parameter. No implicit dependencies.

| Function | Returns |
|---|---|
| `validSimpleMove(cfg)` | `cfg.moves[piece][from][to] == true` |
| `validJumpMove(cfg)` | `cfg.jumps[piece][from][to] == captured` |

Usage:
```rules
import { validSimpleMove, validJumpMove } from 'geometry';

function config() {
  return get(/databases/$(database)/documents/gameConfig/checkers).data;
}

match /games/{gameId} {
  allow update: if validSimpleMove(config()) && piecePlaced();
  allow update: if validJumpMove(config()) && captureValid();
}
```
## `counters`

Denormalized numeric integrity: likes, votes, moves, quantities that may only change by a known step or stay within known bounds.

| Function | Returns |
|---|---|
| `incrementedBy(field, n)` | Field changed by exactly `n` versus the existing document (`n` may be negative). Update rules only |
| `changedBy(field, min, max)` | Field's delta is within `[min, max]`; a delta of 0 passes when the range spans 0 |
| `boundedNumber(field, min, max)` | Incoming value is an int or float within `[min, max]`; a missing field fails the check |

## `timing`

Cooldown and rate-limit enforcement: the stored timestamp must be strictly older than the window.

| Function | Returns |
|---|---|
| `cooldownElapsed(field, seconds)` | `request.time` is later than the stored timestamp plus `seconds`. Update rules only; a missing or non-timestamp field errors, which denies |

Pair with `lifecycle`'s `isServerTimestamp` on the same write so the stored timestamp can't be forged by the client:
```rules
import { cooldownElapsed } from 'timing';
import { isServerTimestamp } from 'lifecycle';

allow update: if cooldownElapsed('lastMoveAt', 2) && isServerTimestamp('lastMoveAt');
```
## `content`

Author-owned documents: posts, notes, docs, comments, tasks. Field names are parameters, not conventions.

| Function | Returns |
|---|---|
| `validAuthorCreate(authorField)` | Signed in, and the incoming document's author field equals the caller. Create rules |
| `isAuthor(authorField)` | The caller is the existing document's author. Update and delete rules |
| `canReadContent(statusField, authorField)` | Published content is public; anything else is visible to its author only. List queries must filter for `status == 'published'` themselves, rules are not filters |
| `notDeleted()` | The existing document's `deleted` field is not `true`. Bracket access, so a document without the field passes |

## `spaces`

Cross-document membership gating for shared spaces (teams, rooms, groups, projects): a parent document defines who may touch its children. Explicit param, like `geometry`: the caller reads the parent doc once and passes its data in.

| Function | Returns |
|---|---|
| `isSpaceMember(spaceData)` | The caller's uid is in `spaceData.members`, covering both list (`['a', 'b']`) and map (`{a: 'admin'}`) shapes |
| `hasSpaceRole(spaceData, role)` | The caller's role in a map-shaped members field equals `role`; denies on a list shape, which carries no roles |
| `validMemberCreate(spaceData, authorField)` | The caller is a member, and the incoming child document's author field equals the caller |

Usage:
```rules
import { isSpaceMember, hasSpaceRole, validMemberCreate } from 'spaces';

match /spaces/{spaceId}/tasks/{taskId} {
  function space() {
    return get(/databases/$(database)/documents/spaces/$(spaceId)).data;
  }
  allow read: if isSpaceMember(space());
  allow create: if validMemberCreate(space(), 'author');
  allow delete: if hasSpaceRole(space(), 'admin');
}
```
## `joining`

Self-service join and leave on a map-shaped `members` field, with no privilege escalation. Compose with `lifecycle`'s `onlyFieldsChanged` so the write can't touch anything else on the document.

| Function | Returns |
|---|---|
| `onlyAddedSelf(membersField, role)` | The write adds exactly the caller to the members map at exactly `role`, changing and removing nobody else |
| `onlyRemovedSelf(membersField)` | The write removes exactly the caller from the members map, adding and changing nobody else |

## `atomic`

Cross-document integrity for batch writes, via the `get()` / `getAfter()` pair: a write is valid only if a companion write happened in the same batch.

| Function | Returns |
|---|---|
| `companionChangedBy(before, after, field, n)` | The companion document's field changed by exactly `n` in this batch; a solo write denies because `after == before` |
| `consumedFlag(before, after, flagField)` | Single-use consumption: `flagField` was `false` before the batch and `true` after; replays and solo writes deny |

`before` and `after` are the same companion document's `get().data` and `getAfter().data`:
```rules
import { companionChangedBy, consumedFlag } from 'atomic';

match /teams/{teamId}/tasks/{taskId} {
  function teamBefore() {
    return get(/databases/$(database)/documents/teams/$(teamId)).data;
  }
  function teamAfter() {
    return getAfter(/databases/$(database)/documents/teams/$(teamId)).data;
  }
  allow create: if companionChangedBy(teamBefore(), teamAfter(), 'taskCount', 1);
}
```
## Importing private functions

Functions in a module that aren't marked `export` are still inlined by the resolver, but renamed with a module prefix (`{module}__{name}`) so they don't collide with source-defined functions or with private helpers in other modules. You can't import a private function by name; doing so produces `UNKNOWN_FUNCTION` with a message that explains the function exists but isn't exported.

## Overriding a stdlib module

Pass a `modules` map to `resolveModules` to shadow a stdlib name:
```ts
import { resolveModules } from 'pyric/rules/internal/node';

resolveModules(source, {
  modules: {
    auth: `
      export function isAuthenticated() {
        return request.auth != null && request.auth.token.email_verified;
      }
      export function isOwner(userId) {
        return isAuthenticated() && request.auth.uid == userId;
      }
    `,
  },
});
```
The `modules` map takes priority over both stdlib and `basePath` resolution.
