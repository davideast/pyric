---
navLabel: "Test rules against Firebase"
---
# How to test rules against the Firebase Rules Test API

Evaluate Firestore rules against Google's live Rules Test API. Use this when the local simulator returns `UNSUPPORTED`, or when you need parity with what production will actually decide.

The Rules Test API does not deploy the rules. It evaluates them against your test cases on Google's servers, in the same engine production uses, and returns pass/fail per case.

`TestFirestoreRulesHandler` is an engine-internal network client, imported from `pyric/rules/internal`. There's no public-front-door equivalent yet: `firestoreRules(source).simulate(cases)` only ever runs the local simulator.

## You need a `ProjectScope`

`TestFirestoreRulesHandler.execute` takes a `ProjectScope` — a `{ projectId, resolveToken }` pair. Build it from a service-account file via `@pyric/cli/credentials/node`:

```ts
import { fromServiceAccount } from '@pyric/cli/credentials/node';

const scope = await fromServiceAccount('./service-account.json');
```

Or build one by hand from any OAuth source, for example the current Firebase Auth user in a browser host:

```ts
const scope = {
  projectId: 'your-project-id',
  resolveToken: () => firebaseAuth.currentUser!.getIdToken(),
};
```

## Run a suite

```ts
import {
  TestFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules/internal';

const handler = new TestFirestoreRulesHandler();
const result = await handler.execute(scope, source, testCases);
```

The result shape is the same internal `TestCase` and `TestResult` types the simulator uses, in the same `{ passed, failed, results }` shape. The only difference is that `result.data.unsupported` is always `0` (the live API never abstains). `TestCase` here is the same shape as the public `FirestoreCase` re-export.

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

**Local-first, escalate on `UNSUPPORTED`**: fast for the common case, accurate when needed.

```ts
import { firestoreRules } from 'pyric/rules';
import { TestFirestoreRulesHandler } from 'pyric/rules/internal';

const local = firestoreRules(source).simulate(testCases);

const needsEscalation = local.cases
  .filter((c) => c.unsupported)
  .map((c) => c.case);

if (needsEscalation.length > 0) {
  const remote = await new TestFirestoreRulesHandler().execute(
    scope, source, needsEscalation,
  );
  // merge `remote.data.results` back into `local.cases` by matching case
}
```

**Test-only**: slower, but bit-for-bit production parity.

```ts
const result = await new TestFirestoreRulesHandler().execute(scope, source, testCases);
```

For most agent workflows, local-first is the right default.

## Cost and latency

Each `execute` call is one HTTP round-trip plus rule evaluation on Google's servers. Budget tens to hundreds of milliseconds per call regardless of how many test cases you pass. The simulator is sub-millisecond per case once parsed.

## Where to look next

- For the tradeoffs between local and live evaluation, see [Simulator vs Rules Test API](../explanation/simulator-vs-rules-test-api.md).
- For the `ProjectScope` contract and `fromServiceAccount`, see [`@pyric/cli/credentials/node`](../../../../cli/README.md#programmatic-subpaths).
- For all error codes the handler can return, see [Errors](../reference/errors.md).
