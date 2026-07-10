---
title: "How to deploy Firestore rules"
navLabel: "Deploy Firestore rules"
group: "pyric-tools / deploy"
section: "How-to"
order: 52
---
# How to deploy Firestore rules

This guide shows you how to deploy a Firestore rules source through `pyric-tools/deploy`. Choose the approach that matches your situation — a one-shot replace, an idempotent ensure, or a manual flow.

## Replace the whole ruleset

When you want to deploy a complete `firestore.rules` file as-is:
```ts
import { firestore } from 'pyric-tools/deploy';

await firestore.rules.deploy(scope, source);
```
The primitive throws `AdminApiError` on any non-2xx. Wrap it in try/catch if you want to branch on status:
```ts
import { AdminApiError, firestore } from 'pyric-tools/deploy';

try {
  await firestore.rules.deploy(scope, source);
} catch (e) {
  if (e instanceof AdminApiError) {
    if (e.status === 400) console.error('Invalid rules:', e.body);
    else if (e.status === 401 || e.status === 403) console.error('Permission denied');
    else console.error('Upstream error:', e.status, e.message);
  } else {
    console.error('Transport error:', e);
  }
}
```
The two-step server flow (create ruleset, PATCH release) is hidden behind the single call.

## Add a rule snippet idempotently

When you want a particular rule snippet to exist in the deployed ruleset — possibly merging into an existing one, possibly writing a fresh template if no rules exist yet:
```ts
import { firestore, recipes } from 'pyric-tools/deploy';

const outcome = await firestore.rules.ensure(scope, recipes.pyricSessions);

if (outcome.ok) {
  console.log(`Status: ${outcome.status}`);  // 'fresh' | 'merged' | 'already-configured'
} else {
  console.error(`[${outcome.code}] ${outcome.message}`);
}
```
`ensure` covers three cases:

| Status | What happened |
|---|---|
| `'fresh'` | No deployed ruleset existed — `freshTemplate` was deployed. |
| `'merged'` | Existing ruleset didn't contain `marker` — `snippet` was injected and deployed. |
| `'already-configured'` | Existing ruleset already contains `marker` — no-op. |

## Write your own recipe

A recipe is just a `{ marker, snippet, freshTemplate }` triple:
```ts
import { firestore } from 'pyric-tools/deploy';

const myRecipe = {
  marker: 'match /audit_log/',
  snippet: `    match /audit_log/{logId} {
      allow create: if request.auth != null;
      allow read: if request.auth.token.role == 'admin';
    }`,
  freshTemplate: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /audit_log/{logId} {
      allow create: if request.auth != null;
      allow read: if request.auth.token.role == 'admin';
    }
  }
}
`,
} as const;

await firestore.rules.ensure(scope, myRecipe);
```
The `marker` should be a substring unique to your snippet — `ensure` uses it to detect whether the rule is already present.

## Check without deploying

To decide UI state ("Configure" vs "Configured") without making any changes:
```ts
const result = await firestore.rules.check(scope, 'match /audit_log/');

switch (result.state) {
  case 'configured':       /* rule present */ break;
  case 'not-configured':   /* rule missing */ break;
  case 'no-rules-yet':     /* greenfield project */ break;
  case 'check-failed':     console.error(result.message); break;
}
```
## Fetch the current source
```ts
const current = await firestore.rules.fetch(scope);
console.log(current ?? '(no ruleset deployed)');
```
Returns `null` for greenfield projects.

## Where to look next

- For the `EnsureRuleOutcome` and `RuleCheckResult` shapes, see [`firestore` namespace](../pyric-tools-deploy-reference-firestore-namespace/#firestorerules).
- For why `ensure` is an orchestrator (returns `Outcome`) while `deploy` is a primitive (throws), see [Primitives throw, orchestrators return](../pyric-tools-deploy-explanation-primitives-vs-orchestrators/).
- For linting rules before deploying them, see [`pyric/rules`](../pyric-rules/).
