---
title: "How to handle AdminApiError and Outcome failures"
navLabel: "Handle errors and outcomes"
group: "pyric-tools / deploy"
section: "How-to"
order: 53
---
# How to handle `AdminApiError` and `Outcome` failures

This guide shows you how to react to failures from `pyric-tools/deploy`. Two error shapes turn up depending on whether you called a primitive (throws) or an orchestrator (returns).

## Primitives — catch `AdminApiError`

Primitives map one REST call to one TypeScript function. They throw on any non-2xx:
```ts
import { AdminApiError, firestore } from 'pyric-tools/deploy';

try {
  await firestore.rules.deploy(scope, source);
} catch (e) {
  if (e instanceof AdminApiError) {
    switch (e.status) {
      case 400: console.error('Bad request:', e.body); break;
      case 401: case 403: console.error('Permission denied'); break;
      case 404: console.error('Not found'); break;
      default:  console.error('Upstream error:', e.status, e.body);
    }
  } else {
    console.error('Transport error:', e);
  }
}
```
`e.body` is the upstream response body, capped at 8 KiB. For 400s from the rules API, that's where the parser error message lives.

## Orchestrators — branch on `outcome.code`

Orchestrators bucket failures into structured codes. The `Outcome` shape is uniform across operations:
```ts
import { firestore } from 'pyric-tools/deploy';

const outcome = await firestore.rules.ensure(scope, recipe);

if (outcome.ok) {
  console.log(`Status: ${outcome.status}`);
} else {
  switch (outcome.code) {
    case 'permission-denied':
      console.error('No IAM. Grant Firebase Admin role.');
      break;
    case 'merge-failed':
      console.error('Could not locate the documents-match block:', outcome.message);
      // Fall back to "paste this snippet manually".
      break;
    case 'unknown':
      console.error('Unexpected failure:', outcome.message);
      break;
  }
}
```
Each orchestrator widens the union with its own coded values (see [Error codes by operation](../pyric-tools-deploy-reference-error-codes/)). The two universal codes — `'permission-denied'` and `'unknown'` — always appear.

## Handle `partial` from batch orchestrators

`firestore.indexes.deployAll` aborts the batch on 403 and returns `partial` with what did succeed:
```ts
const outcome = await firestore.indexes.deployAll(scope, config);

if (!outcome.ok && outcome.partial) {
  console.log(`Started ${outcome.partial.operationsStarted.length} before failure`);
  console.log(`Already existed: ${outcome.partial.alreadyExists}`);
  for (const entry of outcome.partial.perIndex) {
    console.log(`  ${entry.collectionGroup}: ${entry.status}`);
  }
}
```
Use `partial` to either retry just the failed entries or to give the user a useful "12 of 30 succeeded" report.

## Translate exceptions to outcomes in your own code

`withResolvedScope` is the standard wrapper primitives use internally. Reach for it when building your own orchestrator-shaped function on top of the primitives:
```ts
import { withResolvedScope, firestore } from 'pyric-tools/deploy';

async function deployMyRules(scope: ProjectScope, source: string) {
  return withResolvedScope(scope, async (token, projectId) => {
    // Call any primitive that needs a token + projectId.
    await firestore.rules.deploy(scope, source);
    return { source };
  });
}
```
The result is an `Outcome<{ source: string }, 'not-found'>` — `AdminApiError` is bucketed automatically based on HTTP status.

## Don't conflate transport with auth

`withResolvedScope` deliberately maps non-`AdminApiError` exceptions to `'unknown'`, not `'permission-denied'`. A DNS failure or a network blip looks the same as a 403 to a naive `catch`, but the right user-facing response is different. Network errors should usually retry; permission errors should not.

## Where to look next

- For the complete list of orchestrator codes, see [Error codes by operation](../pyric-tools-deploy-reference-error-codes/).
- For why primitives throw and orchestrators return, see [Primitives throw, orchestrators return](../pyric-tools-deploy-explanation-primitives-vs-orchestrators/).
