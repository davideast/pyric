---
title: "Write a Security Rules test suite"
navLabel: "Write a rules test suite"
group: "Secure & debug"
section: ""
order: 30
description: "A suite of allow/deny cases that runs in-process, gates CI, and can escalate to Google's own engine."
---

# Write a Security Rules test suite

A ruleset is code that decides who sees what. It deserves tests like any other code that matters.

In Pyric a rules test is a small fixture, a `TestCase`, and a whole suite runs in-process in milliseconds. No Firebase project, no network, no deploy.

## The fixtures

A `TestCase` describes one hypothetical request and the verdict you expect:
```ts
import { firestoreRules, type FirestoreCase } from 'pyric/rules';

const testCases: FirestoreCase[] = [
  {
    description: 'authenticated read on /notes is allowed',
    expectation: 'ALLOW',
    method: 'get',
    path: 'notes/n1',
    auth: { uid: 'alice' },
  },
  {
    description: 'unauthenticated read on /notes is denied',
    expectation: 'DENY',
    method: 'get',
    path: 'notes/n1',
    // No auth field at all. request.auth is null.
  },
  {
    description: 'owner can update their own note',
    expectation: 'ALLOW',
    method: 'update',
    path: 'notes/n1',
    auth: { uid: 'alice' },
    resource: { ownerId: 'alice', title: 'old title' },
    data: { ownerId: 'alice', title: 'new title' },
  },
  {
    description: 'admin can read any admin doc',
    expectation: 'ALLOW',
    method: 'get',
    path: 'admin/config/secrets/api-keys',
    auth: { uid: 'root', token: { role: 'admin' } },
  },
];
```
The fields map straight onto what the rule sees. `resource` is the existing document, `data` is the proposed write, `auth.uid` becomes `request.auth.uid`, and `auth.token` becomes `request.auth.token` for rules that check custom claims.

## Run the suite
```ts
const result = firestoreRules(source).simulate(testCases);

const { passed, failed, unsupported, cases } = result;
console.log(`${passed} passed · ${failed} failed · ${unsupported} unsupported`);
```
A failed case means the simulator's verdict disagreed with your `expectation`, and its `trace` shows which rule decided. An unsupported case means the simulator hit a feature it does not implement and abstained. It is not counted as a failure, and it is never a guess.

Two fixture fields worth knowing before your suite grows:

- For `update` and merge writes, set `writeMode` so the simulator projects the post-write document the way Firestore does.
- For rules that read `request.time`, pin `requestTime` to an ISO timestamp so the verdict does not depend on the clock. Pass `{ testCases }` to `lintFirestoreRules` and `REQUEST_TIME_NOT_PINNED` flags the cases you missed.

## Gate CI on it

The suite is a script, so CI is one exit code away:
```ts
if (result.failed > 0) {
  for (const r of result.cases) {
    if (!r.passed) console.error(`FAILED: ${r.description}`);
  }
  process.exit(1);
}
```
Sub-millisecond per case once the rules are parsed. There is no reason not to run this on every push.

## Use Google's Rules Test API when production authority matters

The hosted Rules Test API evaluates your cases on Google's servers, in the same engine production uses, without deploying anything. It takes the same `TestCase` objects and returns the same result shape. It needs a real project and credentials:
```ts
import { executeHostedRulesTest } from '@pyric/cli/verify';
import { fromServiceAccount } from '@pyric/cli/credentials/node';

const scope = await fromServiceAccount('./service-account.json');
const remote = await executeHostedRulesTest(scope, source, testCases);
```
The practical pattern is local-first: run everything through the simulator, then send only the `UNSUPPORTED` cases to the hosted engine.
```ts
const escalate = testCases.filter(
  (_, i) => result.cases[i].unsupported,
);
if (escalate.length > 0) {
  const remote = await executeHostedRulesTest(scope, source, escalate);
}
```
Each hosted call is one HTTP round-trip, tens to hundreds of milliseconds. The simulator itself is held to that engine's answers by a parity corpus that runs in CI, so for most suites the local verdicts are the same verdicts, sooner.

## Test Realtime Database rules

Realtime Database rules have their own case type, `RtdbCase`, and their own entry point, `rtdbRules`. Both come from `pyric/rules`. There is no separate `pyric/rules/rtdb` subpath, so import from `pyric/rules` and confirm the export in your installed version before you depend on it.

### Choose a test layer

A rules-only simulation answers most authorization questions. Add the other layers only for the questions it cannot answer.

| Question | Layer | What you need | What it shows |
|---|---|---|---|
| Does this rule allow or deny this request? | Rules-only simulation: `rtdbRules(...).simulate` | The rules JSON and the case data | Behavior for the cases you wrote |
| Does my app code reach those rules with the right identity, and do listeners and errors behave? | Local SDK integration: the sandbox | A sandbox, SDK calls, and signed-in contexts | The local implementation handling your real calls |
| Is the deployed ruleset the one I tested? | `createRtdbInspectRulesTool` | Read-only credentials for the database | The deployed rules and a diff against your local file |
| Does Firebase agree for this ruleset? | Live verification | A Firebase project that runs the rules | The only layer that establishes production behavior |

Simulation needs no Auth user, no SDK module replacement, no browser, and no running database. Local simulation covers the cases you model. It does not establish production parity for your ruleset, and passing a database URL to an in-process evaluator does not make it a live check. For live verification, deploy the rules to a non-production project and run the same cases against it with the Firebase SDK.

The deployed-rules inspector, `createRtdbInspectRulesTool` from `@pyric/cli`, answers a narrower question: whether the rules deployed to a database match your local `database.rules.json`. It sends one read-only `GET` of `<databaseURL>/.settings/rules.json` and returns the deployed rules plus the `.read`, `.write`, `.validate`, and `.indexOn` expressions added, removed, or changed by path. It never deploys or writes data. A match means the rules you tested are the rules that run. It does not show how those rules behave. It is a library tool and is not on the default MCP bridge.

### Write the cases

An `RtdbCase` describes one request against one location:
```ts
import { rtdbRules, type RtdbCase } from 'pyric/rules';

const rules = rtdbRules({
  rules: {
    '.read': false,
    '.write': false,
    records: {
      $recordId: {
        '.read':
          "auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists())",
        '.write':
          "auth != null && (data.exists() ? data.child('ownerId').val() === auth.uid : newData.child('ownerId').val() === auth.uid)",
        '.validate': "newData.hasChildren(['ownerId', 'title'])",
        title: { '.validate': 'newData.isString() && newData.val().length <= 80' },
      },
    },
  },
});

const stored = {
  records: {
    r1: { ownerId: 'alice', title: 'Quarterly plan', reviewers: { rita: true } },
  },
};
const revised = { ownerId: 'alice', title: 'Revised plan', reviewers: { rita: true } };

const cases: RtdbCase[] = [
  { description: 'owner writes', expectation: 'ALLOW', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: revised },
  { description: 'reviewer reads', expectation: 'ALLOW', operation: 'read', path: '/records/r1', auth: 'rita', data: stored },
  { description: 'reviewer cannot write', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'rita', data: stored, newData: revised },
  { description: 'unrelated user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: 'mallory', data: stored },
  { description: 'signed-out user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: null, data: stored },
  { description: 'title over 80 characters', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: { ...revised, title: 'x'.repeat(81) } },
];
```
The fields map onto what the rule sees:

- `operation` is `read`, `write`, or `validate`.
- `path` is an absolute path from the database root, such as `/records/r1`.
- `auth` is a uid string, an object with `uid` and `token` for custom claims, or `null` for a signed-out request. Omitting it is the same as `null`.
- `data` is the database tree before the request, **from the root**, not from `path`. Rules read it as `data`.
- `newData` is the value the request writes at `path`. Rules read it as `newData`.
- `now` is the instant, in epoch milliseconds, that `now` reports. Pin it for any rule that compares against `now`, so the verdict does not depend on the clock.

Each allowed case has denied neighbors that use the same rules and the same `data`. Change one thing at a time: the identity, the operation, or the written value. A reviewer who can read but not write, and a title that breaks `.validate`, each prove a different rule.

### Run the suite
```ts
const summary = rules.simulate(cases);
console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.unsupported} unsupported`);
```
```
6 passed, 0 failed, 0 unsupported
```
`simulate` never throws on a rule outcome. A case that fails its expectation counts as `failed`. A case that uses an expression the simulator cannot evaluate counts as `unsupported`, and it is never a guess.

In a test runner, use `assertCase` so a miss throws with the deciding rule in the message:
```ts
import { test } from 'bun:test';
import { assertCase } from 'pyric/rules';

for (const c of cases) {
  test(c.description!, () => assertCase(rules, c));
}
```
A failing case reports what decided it:
```
FAIL: unrelated user reads
  read /records/r1 (expected ALLOW, got DENY)
  matched auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists()) @ /records/$recordId
  reason: No 'read' rule grants access; the deepest, at '/records/$recordId', evaluated to false
  rules evaluated:
    / .read -> DENY: false
    /records/$recordId .read -> DENY: auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists()) ($recordId = r1)
```
`rules evaluated` lists every `.read`, `.write`, and `.validate` rule the simulator ran, root first, with its verdict (`ALLOW`, `DENY`, `ERROR` with the runtime error, or `UNSUPPORTED`) and the `$` variables bound at that node. The cascade stops at the first grant, and the validate walk stops at the first failure. The same list is on each result as `trace`.

A simulator abstention throws `RulesUnsupportedError`, and an expectation miss throws `RulesAssertionError`, so a runner can treat them differently.

### Know what a write case checks

A `write` case evaluates the `.write` rules from the root to `path`, then every `.validate` rule at and below `path` that the written value reaches. A `.validate` failure denies the write and names the failing rule in `matchedPath` and `matchedRule`. An `operation: 'validate'` case evaluates only the `.validate` rules.

A case describes one write location. It cannot yet describe an atomic update that writes several paths together, so a rule that reads a sibling path written in the same update is not covered by cases. Writing one case for each path evaluates each path against its own value only, and one allowed path does not show that the whole update is safe. Query-gated reads, where a rule reads `query.*`, are not expressible as a case either. Cover both with the sandbox layer below.

Rule expressions compare with `==` and `!=` strictly, as production does. See [simulate and lint before you deploy](./simulate-and-lint.md#know-how-the-simulator-evaluates-rules).

### Test the SDK path with the sandbox

When the question is about how your app calls the database, use the sandbox. Load the rules, seed data with the admin handle, and make requests through signed-in contexts:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get, sandbox as databaseSandbox } from 'pyric/database';

const sandbox = initializeSandbox();
const admin = getDatabase(sandbox);
databaseSandbox.setRules(admin, rules.toJSON());

const alice = getDatabase(sandbox.withAuth({ uid: 'alice' }));
const mallory = getDatabase(sandbox.withAuth({ uid: 'mallory' }));

await set(ref(alice, 'records/r1'), { ownerId: 'alice', title: 'Plan' });
await get(ref(mallory, 'records/r1')); // rejects: PERMISSION_DENIED: Permission denied
```
The rejected call is a plain `Error` whose message is `PERMISSION_DENIED: Permission denied` and whose `code` is `PERMISSION_DENIED`, the same shape the Firebase SDK produces. This layer also covers listeners, transactions, multi-path updates, query-gated reads, and `.indexOn` behavior, which a rules-only case cannot reach. See [run the same backend in tests and scripts](../ship/test-in-node.md) for the harness structure.

### Replay a captured session against new rules

`pyric verify` replays a session captured during development against a candidate ruleset and reports each operation whose verdict changed:
```bash
pyric verify --service rtdb --rules rtdb=database.rules.json
```
RTDB verification runs on the sandbox engine only. The hosted Rules Test API evaluates Firestore rules, so `--engine rules-test-api` is refused for `rtdb`. See [ship to production](../ship/ship-to-production.md).

## Run the suite through an agent

An agent can run the local loop through `firestore_simulate_rules`, which means the rules it writes can arrive with explicit passing cases instead of a promise. For Realtime Database, the agent calls `rtdb_simulate_access` with an `operation`, a `path`, an optional `auth` of `{ uid, claims }`, an optional `newData`, and an optional `now`. The tool evaluates against the rules and data currently loaded in the sandbox, so it needs no separate rules-loading call. It uses the sandbox clock for `now` unless you pass one, and it returns `decision`, `matchedPath`, `matchedRule`, and `reason`. See [Work with an agent](../agent/work-with-an-agent.md).

## Where to go next

A test failure tells you a verdict was wrong. A denial explains why. Read [read a denial and understand it](./read-a-denial.md). Before those rules ship, see [ship to production](../ship/ship-to-production.md).
