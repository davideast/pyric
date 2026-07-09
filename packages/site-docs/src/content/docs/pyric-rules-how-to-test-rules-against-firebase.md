---
title: "How to test rules against the Firebase Rules Test API"
navLabel: "Test rules against Firebase"
group: "pyric / rules"
section: "How-to"
order: 71
---
# How to test rules against the Firebase Rules Test API

This guide shows you how to evaluate Firestore rules against Google's live Rules Test API. Use this when the local simulator returns `UNSUPPORTED`, or when you need parity with what production will actually decide.

The Rules Test API does not deploy the rules — it evaluates them against your test cases on Google's servers, in the same engine production uses, and returns pass/fail per case.

## You need a `ProjectScope`

`TestFirestoreRulesHandler.execute` takes a `ProjectScope` from `pyric-tools/deploy` — a `{ projectId, resolveToken }` pair. Build it from a service-account file:
```ts
import { fromServiceAccount } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
```
Or build one by hand from any OAuth source — for example, the current Firebase Auth user in a browser host:
```ts
import type { ProjectScope } from 'pyric-tools/deploy';

const scope: ProjectScope = {
  projectId: 'your-project-id',
  resolveToken: () => firebaseAuth.currentUser!.getIdToken(),
};
```
## Run a suite
```ts
import {
  TestFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules';

const handler = new TestFirestoreRulesHandler();
const result = await handler.execute(scope, source, testCases);
```
The result shape is identical to `SimulateFirestoreRulesHandler.simulate` — the same `TestCase` and `TestResult` types, the same `{ passed, failed, results }`. The only difference is that `result.data.unsupported` is always `0` (the live API never abstains).

## Handle authentication failures

If the service account lacks the required permission, the call returns `{ success: false, error: { code: 'PERMISSION_DENIED', ... } }`:
```ts
if (!result.success) {
  if (result.error.code === 'PERMISSION_DENIED') {
    console.error(
      'Service account is missing the firebaserules.test permission. '
      + 'Grant the "Firebase Rules Admin" role or include firebaserules.releases.test.',
    );
  } else {
    console.error(result.error.code, result.error.message);
  }
  process.exit(1);
}
```
`error.recoverable` tells you whether retrying makes sense (e.g. `INVALID_REQUEST` is recoverable, `PERMISSION_DENIED` is not).

## Choose simulator-then-test, or test-only

Two common patterns:

**Local-first, escalate on `UNSUPPORTED`** — fast for the common case, accurate when needed:
```ts
import {
  SimulateFirestoreRulesHandler,
  TestFirestoreRulesHandler,
} from 'pyric/rules';

const sim = new SimulateFirestoreRulesHandler();
const local = sim.simulate(source, testCases);

const needsEscalation = local.success
  ? testCases.filter((_, i) => local.data.results[i].state === 'UNSUPPORTED')
  : testCases;

if (needsEscalation.length > 0) {
  const remote = await new TestFirestoreRulesHandler().execute(
    scope, source, needsEscalation,
  );
  // merge `remote.data.results` back into `local.data.results` by index
}
```
**Test-only** — slower but bit-for-bit production parity:
```ts
const result = await new TestFirestoreRulesHandler().execute(scope, source, testCases);
```
For most agent workflows, local-first is the right default.

## Cost and latency

Each `execute` call is one HTTP round-trip plus rule evaluation on Google's servers. Budget tens to hundreds of milliseconds per call regardless of how many test cases you pass. The simulator is sub-millisecond per case once parsed.

## Where to look next

- For the tradeoffs between local and live evaluation, see [Simulator vs Rules Test API](../pyric-rules-explanation-simulator-vs-rules-test-api/).
- For the `ProjectScope` contract and `fromServiceAccount`, see the [`pyric-tools/deploy` package](../pyric-tools-deploy/).
- For all error codes the handler can return, see [Errors](../pyric-rules-reference-errors/).
