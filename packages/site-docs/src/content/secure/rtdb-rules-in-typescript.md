---
title: "Write Realtime Database rules in TypeScript"
navLabel: "RTDB rules in TypeScript"
group: "Secure & debug"
section: ""
order: 60
description: "Compose RTDB rules from typed constraints, prove them in-process, and deploy the compiled JSON."
---

# Write Realtime Database rules in TypeScript

Realtime Database support is still incomplete. Check the generated conformance reference for the exact supported surface before depending on it.

Realtime Database rules are strings inside a JSON tree. Pyric lets you write them as TypeScript instead: typed builders compose into expressions, the expressions assemble into a ruleset, and the ruleset checks itself, simulates requests, and compiles to the exact JSON Firebase deploys. A typo becomes a compile error instead of a production surprise.

## Define the rules in code
```ts
import {
  rtdbRules, defineRtdbRules,
  authenticated, ownerOrNew, immutable,
} from 'pyric/rules';

const rules = rtdbRules(defineRtdbRules({
  paths: {
    '/notes/$noteId': {
      read: authenticated(),
      write: ownerOrNew('ownerId'),
      validate: immutable('createdAt'),
    },
  },
}));
```
`defineRtdbRules` builds the ruleset; `rtdbRules` wraps it in a handle that lints, simulates, and compiles. `$noteId` is a real wildcard. `ownerOrNew('ownerId')` compiles to the signed-in-and-owner-or-new expression you would have written by hand, and `immutable('createdAt')` pins a field after creation. Every builder's output is pinned by tests, so what you compose is what deploys.

## Check it before anything runs
```ts
const issues = rules.lint();
// []
```
`lint()` parses and validates every expression in the tree and returns each problem as an issue with a `code`, a `severity`, and the path it applies to. A definition that cannot compile comes back as a `COMPILE_ERROR`. No deploy, no network.

## Simulate a request
```ts
const summary = rules.simulate([
  {
    description: 'the owner edits their note',
    expectation: 'ALLOW',
    operation: 'write',
    path: '/notes/n1',
    auth: 'alice',
    data: { notes: { n1: { ownerId: 'alice', createdAt: 1 } } },
    newData: { ownerId: 'alice', createdAt: 1, title: 'edited' },
  },
  {
    description: 'another user cannot edit it',
    expectation: 'DENY',
    operation: 'write',
    path: '/notes/n1',
    auth: 'mallory',
    data: { notes: { n1: { ownerId: 'alice', createdAt: 1 } } },
    newData: { ownerId: 'alice', createdAt: 1, title: 'edited' },
  },
]);
// summary.passed === 2
```
The simulator runs in-process against the same grammar the sandbox enforces. `data` is the database tree before the write, from the root; `newData` is the value written at `path`. `auth: 'alice'` is shorthand for `{ uid: 'alice', token: {} }`. Each case result carries the `decision`, whether it `passed`, and the `matchedPath` and `matchedRule` that decided it.

## Ship the JSON
```ts
import { writeFileSync } from 'node:fs';
writeFileSync('database.rules.json', JSON.stringify(rules.toJSON(), null, 2));
```
```bash
pyric rules lint --service database
# or: pyric database rules generate
firebase deploy --only database
```
`toJSON()` emits the `{ rules: ... }` document Firebase expects. Generate or write that file locally (`pyric database rules generate`), then ship it with `firebase-tools` (or the Console) using the path your `firebase.json` points at. The CLI's `rules lint --service database`, `database rules validate`, and `rules simulate --service database` operations run the same checks against the JSON file, so CI can gate on them without TypeScript in the loop.

## Turn enforcement, from a deployed game

This turn-enforcement example is built from the same parts:
```ts
import {
  ruleset, deny, any, isNew, authenticated,
  turnGuard, flip, winCheckHelper,
} from 'pyric/rules';

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

const game = ruleset({
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

## And from an agent

An agent authors and checks the same way you do: lint and simulate locally (`pyric rules lint --service database`, `pyric rules simulate --service database`, or `rtdb_simulate_access` against the connected sandbox), generate JSON with `pyric database rules generate`, then ship with `firebase-tools`. See the RTDB task in [Work with an agent](../agent/work-with-an-agent.md).

## Where to go next

The full builder catalog, with the exact expression each one produces, is in the [constraints reference](pyric-database-reference-api.md). For the data side of RTDB, see [Sync realtime data](../build/realtime-database.md).
