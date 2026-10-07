---
title: "Use tested builders in Realtime Database rules"
navLabel: "RTDB rules standard library"
group: "Secure & debug"
section: ""
order: 65
description: "Compose Realtime Database rules from standard library modules for matches, turns, results, counters, presence, rate limits and validated shapes."
---

# Use tested builders in Realtime Database rules

The Firestore and Storage rules standard library is rules source you import. Realtime Database rules have no functions, no imports and no `let`, so the RTDB standard library is TypeScript instead: each module is a namespace of builders, and each builder returns the whole expression for one `.write` or `.validate` rule. You compose builders with `all`, `any` and `not` inside `defineRtdbRules`, and `toJSON()` gives you the `database.rules.json` Firebase deploys.

The modules follow the same conventions as their Firestore counterparts, so a game that keeps its lobby in Firestore and its live play in the Realtime Database uses one data layout for both.

## Build a match from modules

```ts
import {
  rtdbRules, defineRtdbRules, rtdbStdlib,
  all, any, not, authenticated, newDataExists,
} from 'pyric/rules';

const { lobby, turns, results, lifecycle, validation, counters } = rtdbStdlib;

const rules = rtdbRules(defineRtdbRules({
  paths: {
    '/matches/$matchId': {
      read: authenticated(),
      write: any(
        all(lobby.validCreate(), not(newDataExists('rematchOf'))),
        lobby.validRematch(),
        lobby.validJoin(),
        lobby.canCancel(),
        results.resignedBy(),
        all(turns.isMyTurn(), results.finishedWithWinner('host', 'won')),
        all(turns.isMyTurn(), results.finishedWithWinner('guest', 'won')),
        all(turns.isMyTurn(), results.finishedWithWinner('', 'draw')),
        all(
          turns.isMyTurn(),
          turns.turnFlipped(),
          lifecycle.onlyFieldsChanged(['currentTurn', 'moveCount'], lobby.MATCH_FIELDS),
        ),
      ),
      ...validation.shape(
        {
          host: 'string',
          guest: 'string',
          status: validation.oneOf('waiting', 'playing', 'won', 'draw', 'resigned'),
          currentTurn: validation.oneOf('host', 'guest'),
          winner: validation.oneOf('', 'host', 'guest'),
          moveCount: { validate: counters.incrementedBy(1, { start: 0 }) },
          rematchOf: 'string',
        },
        { required: ['host', 'guest', 'status'] },
      ),
    },
  },
}));
```
Every builder in the match modules reads the stored match (`data`) and the match after the write (`newData`) at the match node. A join written as `update(matchRef, { guest: uid, status: 'playing' })` and a create written as `set(matchRef, match)` both reach the same `.write`, because `newData` at the match node is the merged match after the write.

## Know where each builder goes

Each catalog entry names its placement. There are three:

- **Match or record node `.write`:** `lobby`, `turns`, `results` and the `lifecycle` change checks. A `.write` that grants on an ancestor grants every write below it, so keep `/matches` and the root without a granting `.write`.
- **Field node `.validate`:** the `validation` value checks and the single-counter checks in `counters`. They read `newData` of the node they sit on.
- **Record node, spread in:** `validation.shape(spec)` returns `{ validate, children }`. The children type each field, and a `$other` wildcard whose `.validate` is `false` refuses any other child.

`.validate` runs for the nodes a write carries and their ancestors, never for an unwritten sibling and never for a node whose new value is null. Two consequences:

- A delete skips every `.validate`, so a delete rule belongs in `.write` (`lobby.canCancel()`, `lifecycle.noDelete()`).
- A set of a parent that carries an unchanged step-checked counter runs the counter's `.validate` and is refused. Write that counter on its own, or use `counters.changedBy(min, max)` with a range that includes 0.

## Modules

| Module | What it checks | Placement |
|---|---|---|
| `validation` | Types, string length, number range, allowed values, regular expressions, required fields, closed shapes | Field `.validate`; `shape` on the record |
| `lifecycle` | Fields that may or must change, immutable fields, ownership through a uid field, write-once and no-delete nodes | Record `.write` |
| `lobby` | Create, join, cancel, rematch a two-player match | Match `.write` |
| `turns` | The seat on turn and the next turn, for two seats or a seat list | Match `.write` |
| `results` | Resignation, win, draw, and moves that keep the result | Match `.write` |
| `counters` | Steps, ranges, improving scores, one side of a score at a time | Counter `.validate` |
| `presence` | A per-user online node only its owner writes, cleared by an onDisconnect write | The presence path's definition |
| `timing` | Server timestamps, times not in the future, cooldowns, per-user rate limits | Field `.validate`, or the record with a field |
| `collections` | Slot keys `'0'` to `max - 1` and fixed key lists, which bound a collection's size | Wildcard `.validate` |
| `auth` | Signed in, a verified email or email domain, custom-claim roles, roles stored in the database, the tenant | Any `.read` or `.write` |
| `membership` | A member list stored in the database, and members who add or remove only themselves | Any `.read` or `.write`; the member node |

The match convention is the Firestore one: `host` and `guest` hold uids (`guest` is `''` while open), `status` is `'waiting'`, `'playing'`, then `'won'`, `'draw'` or `'resigned'`, `currentTurn` is `'host'` or `'guest'`, `winner` is `'host'`, `'guest'` or `''`, and `moveCount` is a number. A rematch also has `rematchOf`, the finished match it follows. `lobby.MATCH_FIELDS` lists all seven for the changed-field checks, so a join, move, resignation or finish leaves every field it does not name unchanged.

Create the match with `currentTurn`, `winner` and `moveCount` as well as `host`, `guest` and `status`, for example `{ host: uid, guest: '', status: 'waiting', currentTurn: 'host', winner: '', moveCount: 0 }`. `validJoin` keeps those fields unchanged, so a match created without `currentTurn` never has a seat on turn and `turns.isMyTurn()` never allows a move. A seat list stores one uid per seat under `players/0` to `players/n-1` and the seat on turn in `turn`; RTDB rules have no loops, so `turns.isSeatTurn(n)` and `turns.turnAdvanced(n)` take the seat count when you build the rules and write one comparison per seat.

RTDB rules cannot list a node's children. The changed-field checks therefore take the record's leaf field list and compare each field before and after the write. Pair them with `validation.shape` so a write cannot add a field the list does not name, and compare leaf fields only.

## Show who is online

```ts
import { getDatabase, ref, set, onDisconnect, serverTimestamp } from 'firebase/database';

// Rules: '/status/$uid': rtdbStdlib.presence.record()
const statusRef = ref(getDatabase(), `status/${uid}`);
await onDisconnect(statusRef).set({ state: 'offline', lastChanged: serverTimestamp() });
await set(statusRef, { state: 'online', lastChanged: serverTimestamp() });
```
`presence.record()` lets only the owner write `/status/$uid`, as `{ state: 'online' | 'offline', lastChanged }` with `lastChanged` the server timestamp and no other child. Production checks the rules for an onDisconnect write when the client registers it and again when it runs, so the offline value must pass the same rules as the online one. Production's verdict for a server timestamp inside an onDisconnect value has not been captured; the sandbox resolves it when the write runs. `onDisconnect(statusRef).remove()` is a delete, which the owner's `.write` allows. `presence.flag()` is the same node as a boolean.

RTDB has no functions, so a match reads a player's presence through `data.parent()`, for example to let the other player claim a forfeit once the guest's state is `'offline'`.

## Limit how often a user writes

```ts
const { timing, lifecycle } = rtdbStdlib;

paths: {
  '/posts/$postId': {
    write: authenticated(),
    validate: timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }]),
  },
  // A deleted stamp would reset the cooldown, so the owner may not delete it.
  '/lastPost/$uid': { write: all(ownPath('$uid'), lifecycle.noDelete()), validate: timing.throttled(60_000) },
}

// Client: the post and the stamp in one multi-path update.
await update(ref(db), { 'posts/p1': post, [`lastPost/${uid}`]: serverTimestamp() });
```
`now` is the server clock in milliseconds, and the server replaces a written `serverTimestamp()` with `now` before it evaluates the rules. The stamp's `.validate` requires the server timestamp and refuses it until 60 seconds after the stored one; the post's `.validate` requires the stamp in the same write. A post without a stamp, a stamp with a client clock time, a stamp under another uid, and a delete of the stamp are all refused. The limit is on writes, not posts: one multi-path update can carry several posts and one stamp. For a cooldown on one record, combine `timing.cooldownElapsed(ms, 'lastMoveAt')` with `timing.isServerTimestamp('lastMoveAt')` in its `.write`.

## Check who the writer is

```ts
const { auth, membership } = rtdbStdlib;

paths: {
  '/staff': { write: auth.emailDomain('example.com') },           // verified email at the domain
  '/admin': { write: auth.hasAnyRole('admin', 'editor') },          // custom claim role
  '/orgs/$orgId/docs/$docId': {
    // the role stored at /orgs/$orgId/roles/<uid>, two levels above the doc
    write: auth.roleAt(['roles', { $: 'auth.uid' }], 'editor', { levelsUp: 2 }),
  },
  '/rooms/$roomId/messages/$msgId': {
    read: membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 }),
  },
  '/rooms/$roomId/members/$uid': {
    write: membership.selfMembership('$uid'),
    validate: membership.memberFlag(),
  },
}
```
`auth.token` carries `email` and `email_verified` only when the account has an email, and custom claims as you set them with the Admin SDK. Each builder checks `auth != null` first, and `emailDomain` checks `email_verified` before it reads `email`. The `emailDomain` comparison is exact and case-sensitive: an address stored as `Ada@Example.com` does not pass `auth.emailDomain('example.com')`, so the check fails closed on mixed-case addresses. Claims compare without type conversion: a claim stored as the string `'true'` does not pass `auth.hasClaim('beta')`. `auth.hasClaim(name, null)` throws, because a token without the claim reads it as `null`. `auth.tenantIs(id)` and `auth.inTenant('$tenantId')` read `auth.token.firebase.tenant`.

`roleAt` trusts the role stored in the database, so the roles node must not be writable by the user it describes. That includes a `.write` on any parent of the roles node: `.write` cascades, so a parent grant lets the user write their own role.

A member is a key whose value is `true`. `memberOf` reads the stored data, so a write that adds the writer to the list cannot use that same write to pass the check. Pass `levelsUp` to read the list relative to the node, so the rules work wherever they are mounted; without it the segments start at `root`.

`selfMembership` with `memberOf` makes a room open to join: any signed-in user can add themselves to the member list and then post in the next write. For an invite-only room, give the member node an owner-only `.write` instead of `selfMembership`.

## Limit writes per time window

```ts
paths: {
  '/posts/$postId': {
    write: all(authenticated(), lifecycle.createOnly()),
    validate: timing.countedInSameWrite(2, ['quota', { $: 'auth.uid' }]),
  },
  // At most 10 posts per minute per user.
  '/quota/$uid': {
    write: all(ownPath('$uid'), lifecycle.noDelete()),
    validate: timing.windowedQuota(10, 60_000),
  },
}

// A post that opens a window, then one inside it:
await update(ref(db), { 'posts/p1': post, [`quota/${uid}`]: { windowStart: serverTimestamp(), count: 1 } });
await update(ref(db), { 'posts/p2': post, [`quota/${uid}/count`]: 2 });
```
The quota node holds `{ windowStart, count }`. A write either opens a new window, with `windowStart` the server timestamp and `count` 1, once nothing is stored or the stored window has ended, or adds 1 to `count` in the open window, up to the maximum. A post must move the quota in the same write. Like the cooldown stamp, the quota limits writes, not posts: one multi-path update can carry several posts and one count.

## Bound a collection

RTDB rules cannot count a node's children. Bound the keys instead: `collections.slotKey('$slot', 4)` on `'/seats/$slot'` allows the keys `'0'` to `'3'`, which is how a client stores an array, so a fifth seat is refused. `collections.keyIn('$flag', ['red', 'blue'])` allows a fixed list. The library has no builder for a collection with free keys, such as push IDs.

## Ask an agent

An agent reads the same catalog through the rules tools:

- `rules_stdlib_list` with `service: 'database'` lists the modules, each function's placement, and the length of the expression its example compiles to.
- `rules_stdlib_get` with `service: 'database'` and a key returns each builder's signature, placement, example, the exact expression the example compiles to, and notes.

From the CLI bridge, `rules.listStdlib({ service: 'database' })` and `rules.getStdlib({ module: 'turns', service: 'database' })` reach the same tools.

## What the RTDB library leaves out

Some Firestore modules have no RTDB counterpart:

- **`content` (a document hidden from the other players until the match ends):** RTDB cannot hide part of a node someone can read, because `.read` cascades to every child. Store each player's hidden value at its own path, such as `/hands/$matchId/$uid` with `.read: auth.uid === $uid`, and make it write-once with `lifecycle.createOnly()`. When the match ends, the player copies it to a public path whose `.validate` compares the revealed value with the hidden one, for example `newData.val() == root.child('hands').child($matchId).child(auth.uid).val()`, so the reveal cannot differ from what was committed.
- **`fairness` (commit and reveal):** RTDB rules have no hashing functions, so a rule cannot check a revealed value against its commitment.
- **`geometry` (squares such as `'e4'`):** RTDB rules have no string-to-number conversion or character lookup. Store a square as two numbers, `file` and `rank`, and check them with `validation.numberBetween`.
- **`storage/*`:** Storage only.

## How the library is tested

Every builder's output is pinned by a test, and every module has allow and deny cases that run through `rtdbRules(...).simulate` and through the sandbox's deployed rules with the client SDK; the two must agree with each case. The main patterns are also deployed to a production Realtime Database and their verdicts recorded; see [How we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md).

## Where to go next

- [Write Realtime Database rules in TypeScript](rtdb-rules-in-typescript.md) covers `defineRtdbRules`, `lint`, `simulate` and shipping the JSON.
- [Use tested modules in Firestore Security Rules](rules-standard-library.md) covers the Firestore and Storage library.
