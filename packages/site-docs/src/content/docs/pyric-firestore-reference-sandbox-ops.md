---
title: "Sandbox-only operations"
group: "pyric / firestore"
section: "Reference"
order: 85
---
# Sandbox-only operations

Three operations live under the `sandbox` namespace export and only work against sandbox-backed `Firestore` handles. Calling them on a prod-backed handle throws `SandboxError('failed-precondition')`.
```ts
import { sandbox } from 'pyric/firestore';
```
## `sandbox.setRules(db, rules): LintResult`

Replace the active ruleset in the sandbox's `LocalEnvironment`.
```ts
sandbox.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`);
```
Returns the `LintResult` from `pyric/rules`. Source with parse-level errors is not swapped; check the warnings.

After a successful swap, every active snapshot listener re-evaluates under the new rules. See [Listener re-evaluation on `deployRules`](../pyric-sandbox-explanation-listener-re-evaluation/).

On prod, import `firestore` from `pyric-tools/deploy` and call `firestore.rules.deploy(...)`. That hits Firebase's rules API.

## `sandbox.seedDocuments(db, documents): LintResult`

Bulk-load documents into the sandbox state, bypassing rules.
```ts
sandbox.seedDocuments(db, {
  'notes/n1': { ownerId: 'alice', title: 'first' },
  'notes/n2': { ownerId: 'bob', title: 'second' },
});
```
The active ruleset is preserved. Return value is the lint of the existing rules for shape consistency with `setRules`.

On prod, populate data via writes. There's no bulk-seed API.

## `sandbox.snapshotState(db): Record<string, DocumentData>`

Capture every stored document as a `{ [path]: data }` map. Reads the live state independent of rules.
```ts
const state = sandbox.snapshotState(db);
console.log(state['notes/n1']);  // { ownerId: 'alice', title: 'first' }
```
The returned object is a structural clone. Mutating it does not affect the sandbox.

On prod, this surface doesn't exist. There's no efficient "dump every doc" API in Firebase's data plane.

## Why a namespace export

The three operations could have been top-level exports (`setSandboxRules`, `seedSandboxDocuments`, etc.). We chose the namespace because:

- They're sandbox-only by contract. Grouping them under `sandbox.*` makes "this won't work on prod" visible at the call site.
- A code reader scanning imports sees `sandbox` and knows the file is doing sandbox-flavoured operations. Three separate prefixed exports would scatter that signal.
- Future sandbox-only additions slot in without further import-list churn.

The local-variable collision (you might already have `const sandbox = initializeSandbox()`) is annoying but rare in practice. When it happens, alias on import:
```ts
import { sandbox as sandboxOps } from 'pyric/firestore';
const sandbox = initializeSandbox();
sandboxOps.setRules(db, RULES);
```
## Why `setRules` lives here, not on the handle

The `pyric-admin` handle exposes `setRules` directly: `db.setRules(...)`. `pyric/firestore`'s handle is opaque (the only public property is `TARGET_SYMBOL`), so the same shape would mean adding a method. We didn't because:

- The handle's shape is the *upstream-SDK* shape. Adding a `setRules` method would deviate from `firebase/firestore`'s `Firestore` type and break the swap-in contract.
- A free function `sandbox.setRules(db, rules)` keeps the handle pure and surfaces the sandbox-only nature through the namespace name.

Both styles work. The chosen tradeoff in `pyric/firestore` is "stay shape-faithful to upstream"; in `pyric-admin` it's "match the admin SDK's method-on-handle style". Each package picks the convention that matches its target SDK.

## Where to look next

- For the lint result shape, see [`pyric/rules` lint rules reference](../pyric-rules-reference-lint-rules/).
- For prod rule deploys, see [`pyric-tools/deploy`'s firestore namespace](../pyric-tools-deploy-reference-firestore-namespace/).
