# @pyric/rules

Unit-test Firebase Security Rules for Firestore, Cloud Storage and Realtime
Database in plain Node, without an emulator and without the rest of pyric.
It parses, lints and simulates your rules files in process.

It is not published to npm yet. Until it is, it ships inside `pyric` as
`pyric/rules`, with the same API.

```sh
npm install --save-dev @pyric/rules
```

Requires Node 22 or later. It depends on `ohm-js` and `zod` only.

## Firestore

```js
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertCase, firestoreRules, rtdbRules, storageRules } from '@pyric/rules';

const rules = firestoreRules(readFileSync('firestore.rules', 'utf8'));

test('another user cannot read a note', () => assertCase(rules, {
  description: 'another user cannot read a note',
  expectation: 'DENY',
  method: 'get',
  path: 'notes/n1',
  auth: { uid: 'bob' },
  resource: { owner: 'alice', text: 'hi' },
}));
```

`assertCase` throws a `RulesAssertionError` that explains the decision when
the rules answer differently, so any test runner reports it. The examples
below use the same imports.

## Cloud Storage

```js
const rules = storageRules(readFileSync('storage.rules', 'utf8'), { bucket: 'demo-app.appspot.com' });

test('a user uploads a small image as their avatar', () => assertCase(rules, {
  description: 'a user uploads a small image as their avatar',
  expectation: 'ALLOW',
  method: 'create',
  path: 'avatars/alice/me.png',
  auth: { uid: 'alice' },
  requestResource: { size: 2048, contentType: 'image/png' },
}));
```

A Storage case names the verb production checks: `get`, `list`, `create`,
`update` or `delete`, or `read` for `get` and `list` together. There is no
`write`.

## Realtime Database

```js
const rules = rtdbRules(readFileSync('database.rules.json', 'utf8'));

test('nobody writes another user\'s profile', () => assertCase(rules, {
  description: 'nobody writes another user\'s profile',
  expectation: 'DENY',
  operation: 'write',
  path: '/profiles/alice',
  auth: 'bob',
  newData: { name: 'Mallory' },
}));
```

## Without a test runner

Each ruleset also has `simulate(cases)`, which returns every result as data
with pass, fail and unsupported counts, `explain(case)` for one decision, and
`lint()`. `lint(source)` reads any text and returns its issues without
throwing. A case the engine cannot evaluate is `UNSUPPORTED`, never a pass,
and `assertCase` throws `RulesUnsupportedError` for it. A case's `auth` and
`resource` become `request.auth` and `resource` exactly as given: nothing is
filled in, such as token claims or object metadata.

## Entry points

| Import | Stability |
|---|---|
| `@pyric/rules` | The public API above. |
| `@pyric/rules/internal`, `/internal/node`, `/internal/rtdb`, `/internal/storage` | Unstable. For pyric's own packages; they change without notice. |

The `pyric` package re-exports this one as `pyric/rules`, so an app that
already uses pyric can import from either.
