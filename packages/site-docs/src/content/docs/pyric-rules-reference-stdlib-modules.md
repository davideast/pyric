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
