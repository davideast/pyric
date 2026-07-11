---
title: "Author your first RTDB rules with constraints"
navLabel: "Author RTDB rules"
group: "pyric / database"
section: "Tutorials"
order: 160
---
# Author your first RTDB rules with constraints

This tutorial creates a small Realtime Database rules document in memory, checks
it, and simulates one write before you hand the generated JSON to deploy
tooling.

You will build rules for room messages:

- nobody can read or write at the root
- signed-in room members can write messages
- each message must include `author`, `text`, and `createdAt`
- `createdAt` cannot change after creation

## Create the rules document

Create `database.rules.ts`:
```ts
import { z } from 'zod';
import {
  AUTH_UID,
  all,
  authenticated,
  defineRtdbRules,
  deny,
  eq,
  immutable,
  newDataVal,
  rootExists,
} from 'pyric/rules';

const isRoomMember = rootExists(['members', { $: '$roomId' }, { $: 'auth.uid' }]);

export const rules = defineRtdbRules({
  paths: {
    '/': { read: deny(), write: deny() },
    '/rooms/$roomId/messages/$messageId': {
      read: isRoomMember,
      write: all(
        authenticated(),
        isRoomMember,
        eq(newDataVal('author'), AUTH_UID),
        immutable('createdAt'),
      ),
      schema: z.object({
        author: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      indexOn: ['createdAt'],
    },
  },
});
```
## Check the document

Save a small check script as `database.rules.check.ts`:
```ts
import { rules } from './database.rules.js';

const check = rules.check();

if (!check.ok) {
  console.error(check.errors);
  process.exit(1);
}

console.log(rules.toJSON());
```
Run it:
```bash
bun database.rules.check.ts
```
You will see a complete Firebase RTDB rules JSON object. The `check()` call
also returns lint warnings, so you can decide whether to fail your own workflow
on warnings.

## Simulate a write

Save one simulation as `database.rules.simulate.ts`:
```ts
import { rules } from './database.rules.js';

const result = rules.simulate({
  operation: 'write',
  path: '/rooms/r1/messages/m1',
  auth: 'alice',
  data: {
    members: {
      r1: { alice: true },
    },
  },
  newData: {
    author: 'alice',
    text: 'hello',
    createdAt: 1,
  },
});

console.log(result);
```
Run it:
```bash
bun database.rules.simulate.ts
```
The result is allowed. Change `auth` to `'bob'` or change `newData.author` to a
different uid and run it again; the same rule document now denies the write.

## Generate JSON for deployment

Write the compiled JSON with the Node helper:
```ts
import { writeRtdbRulesFile } from 'pyric/rules/internal/node';
import { rules } from './database.rules.js';

await writeRtdbRulesFile(rules, 'database.rules.json');
```
or from the CLI, without writing a script at all:
```sh
pyric database:rules:generate --config database.rules.ts --out database.rules.json
```
Both routes compile through the same `rules.toJSON()` call. See
[RTDB rules tooling](../pyric-database-reference-rules-tooling/#generating-databaserulesjson)
for the full reference, including the `rtdb_generate_rules` MCP tool.

You have built an in-memory rules document, checked it, simulated it, and
generated the JSON expected by Firebase Realtime Database.

## Verify a captured app journey

After running `pyric dev` and exercising the app, the latest session is saved
to `.pyric/last-session.json`. You can verify that capture against the in-memory
rules document before generating JSON:
```ts
import { verifyFixture } from 'pyric-tools/verify';
import { rules } from './database.rules.js';

const fixture = JSON.parse(await Bun.file('.pyric/last-session.json').text());
const result = await verifyFixture(fixture, {
  rules: { rtdb: rules },
});

if (!result.ok) {
  console.error(result.services.rtdb?.divergences);
  process.exit(1);
}
```
For the CLI path, use the JSON file from the previous step:
```bash
pyric verify --service rtdb --rules rtdb=database.rules.json
```