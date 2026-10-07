---
title: "Use tested builders in Realtime Database rules"
navLabel: "RTDB rules standard library"
group: "Secure & debug"
section: ""
order: 65
description: "Compose Realtime Database rules from standard library modules for matches, turns, results, counters, and validated shapes."
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

The match convention is the Firestore one: `host` and `guest` hold uids (`guest` is `''` while open), `status` is `'waiting'`, `'playing'`, then `'won'`, `'draw'` or `'resigned'`, `currentTurn` is `'host'` or `'guest'`, `winner` is `'host'`, `'guest'` or `''`, and `moveCount` is a number. A rematch also has `rematchOf`, the finished match it follows. `lobby.MATCH_FIELDS` lists all seven for the changed-field checks, so a join, move, resignation or finish leaves every field it does not name unchanged.

Create the match with `currentTurn`, `winner` and `moveCount` as well as `host`, `guest` and `status`, for example `{ host: uid, guest: '', status: 'waiting', currentTurn: 'host', winner: '', moveCount: 0 }`. `validJoin` keeps those fields unchanged, so a match created without `currentTurn` never has a seat on turn and `turns.isMyTurn()` never allows a move. A seat list stores one uid per seat under `players/0` to `players/n-1` and the seat on turn in `turn`; RTDB rules have no loops, so `turns.isSeatTurn(n)` and `turns.turnAdvanced(n)` take the seat count when you build the rules and write one comparison per seat.

RTDB rules cannot list a node's children. The changed-field checks therefore take the record's leaf field list and compare each field before and after the write. Pair them with `validation.shape` so a write cannot add a field the list does not name, and compare leaf fields only.

## Ask an agent

An agent reads the same catalog through the rules tools:

- `rules_stdlib_list` with `service: 'database'` lists the modules, each function's placement, and the length of the expression its example compiles to.
- `rules_stdlib_get` with `service: 'database'` and a key returns each builder's signature, placement, example, the exact expression the example compiles to, and notes.

From the CLI bridge, `rules.listStdlib({ service: 'database' })` and `rules.getStdlib({ module: 'turns', service: 'database' })` reach the same tools.

## What the RTDB library leaves out

Some Firestore modules have no RTDB counterpart:

- **`content` (a document hidden from the other players until the match ends):** RTDB cannot hide part of a node someone can read, because `.read` cascades to every child. Store each player's hidden value at its own path, such as `/hands/$matchId/$uid` with `.read: auth.uid === $uid`, and copy it to a public path when the match ends.
- **`fairness` (commit and reveal):** RTDB rules have no hashing functions, so a rule cannot check a revealed value against its commitment.
- **`geometry` (squares such as `'e4'`):** RTDB rules have no string-to-number conversion or character lookup. Store a square as two numbers, `file` and `rank`, and check them with `validation.numberBetween`.
- **`storage/*`:** Storage only.

## How the library is tested

Every builder's output is pinned by a test, and every module has allow and deny cases that run through `rtdbRules(...).simulate` and through the sandbox's deployed rules with the client SDK; the two must agree with each case. The main patterns are also deployed to a production Realtime Database and their verdicts recorded; see [How we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md).

## Where to go next

- [Write Realtime Database rules in TypeScript](rtdb-rules-in-typescript.md) covers `defineRtdbRules`, `lint`, `simulate` and shipping the JSON.
- [Use tested modules in Firestore Security Rules](rules-standard-library.md) covers the Firestore and Storage library.
