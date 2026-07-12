---
title: "Write Realtime Database rules in TypeScript"
navLabel: "RTDB rules in TypeScript"
group: "Secure & debug"
section: ""
order: 3007
description: "Compose RTDB rules from typed constraints, prove them in-process, and deploy the compiled JSON."
---

# Write Realtime Database rules in TypeScript

> Realtime Database support is experimental. [How we know it matches Firebase](../how-we-know-it-matches-firebase/) explains the boundary.

Realtime Database rules are strings inside a JSON tree. Pyric lets you write them as TypeScript instead: typed builders compose into expressions, the expressions assemble into a ruleset, and the ruleset checks itself, simulates requests, and compiles to the exact JSON Firebase deploys. A typo becomes a compile error instead of a production surprise.

## Define the rules in code
```ts
import {
  defineRtdbRules, all, authenticated,
  fieldOwnerOnly, ownerOrNew, immutable,
} from 'pyric/rules/rtdb/constraints';

const rules = defineRtdbRules({
  paths: {
    '/notes/$noteId': {
      read: authenticated(),
      write: ownerOrNew('ownerId'),
      validate: immutable('createdAt'),
    },
  },
});
```
`$noteId` is a real wildcard. `ownerOrNew('ownerId')` compiles to the signed-in-and-owner-or-new expression you would have written by hand, and `immutable('createdAt')` pins a field after creation. Every builder's output is pinned by tests, so what you compose is what deploys.

## Check it before anything runs
```ts
const result = rules.check();
// { ok: true, errors: [], warnings: [] }
```
`check()` parses, validates, and lints every expression in the tree. A `==` where you meant `===` comes back as a `LOOSE_EQUALITY` warning with its path and rule. An unsupported schema type is a `COMPILE_ERROR`. No deploy, no network.

## Simulate a request
```ts
const verdict = rules.simulate({
  operation: 'write',
  path: '/notes/n1',
  auth: 'alice',
  data: { ownerId: 'alice', createdAt: 1 },
  newData: { ownerId: 'alice', createdAt: 1, title: 'edited' },
});
```
The simulator runs in-process against the same grammar the sandbox enforces. `auth: 'alice'` is shorthand for `{ uid: 'alice', token: {} }`. Ask the denial question the same way: change `auth` to `'mallory'` and read the verdict.

## Ship the JSON
```ts
import { writeFileSync } from 'node:fs';
writeFileSync('database.rules.json', JSON.stringify(rules.toJSON(), null, 2));
``````bash
pyric database:rules:lint database.rules.json
pyric deploy database
```
`toJSON()` emits the `{ rules: ... }` document Firebase expects, and `pyric deploy database` ships the file your `firebase.json` points at. The CLI's `database:rules:lint`, `database:rules:validate`, and `database:rules:simulate` run the same checks against the JSON file, so CI can gate on them without TypeScript in the loop.

## Enforce turns and wins in a deployed game

The tic-tac-toe [case study](../rules-case-studies/) is built from these same parts, deployed and playable:
```ts
import {
  ruleset, deny, any, isNew, authenticated,
  turnGuard, flip, winCheckHelper,
} from 'pyric/rules/rtdb/constraints';

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

const game = ruleset('https://<db>.firebaseio.com', {
  '/': { read: deny(), write: deny() },
  '/games/$gameId': {
    read: authenticated(),
    write: any(isNew(), turnGuard('currentTurn', { X: 'playerX', O: 'playerO' }, 'status', 'playing')),
    children: {
      '/currentTurn': { validate: flip(['X', 'O']) },
      '/xWins': { validate: winCheckHelper('X', LINES) },
      '/oWins': { validate: winCheckHelper('O', LINES) },
    },
  },
});
```
Three constraints carry the whole game. `turnGuard` reads stored state, never the incoming write, so a player cannot hand themselves the turn. `flip` makes turn order a validation rule. And `winCheckHelper` verifies a win claim against the actual board, so the winner field only accepts the truth.

## Author and simulate RTDB rules from an agent

An agent authors and checks the same way you do: `rtdb_build_expression` parse-checks a single expression before it enters a ruleset, `rtdb_simulate_access` evaluates an operation against the deployed rules (fetch them first with `rtdb_get_rules`), and `rtdb_deploy_rules` ships the result. The [rtdb-security-rules skill](../skills/) packages the whole discipline.

## Where to go next

The full builder catalog, with the exact expression each one produces, is in the [constraints reference](../pyric-database-reference-constraints/). For the data side of RTDB, see [Sync realtime data](../sync-realtime-data/).
