---
title: "pyric-tools/deploy"
navLabel: "Overview"
group: "pyric-tools / deploy"
section: ""
order: 15
---
# `pyric-tools/deploy`

Firebase control-plane primitives — Hosting, Cloud Functions Gen 2, Firestore rules, Firestore indexes, Firestore database provisioning, and Realtime Database rules — without the `firebase` CLI. Pure-fetch over OAuth access tokens; works in Node and the browser alike.

The package is organised around three things:

- **`ProjectScope`** — a tiny `{ projectId, resolveToken }` pair every primitive takes as its first argument. Build one from a service-account JSON (Node) or from `firebaseAuth.currentUser.getIdToken()` (browser).
- **Namespaced primitives** — `hosting`, `functions`, `firestore`, `rtdb`, and `recipes`. Each groups the operations for one Firebase product.
- **Tool factories** — `createHostingDeployTools`, `createFunctionsDeployTools`, `createFirestoreDeployTools`, `createRtdbDeployTools`. Each returns a `ToolHandler[]` ready to feed an `@inbrowser/agent` registry.

## Install
```bash
bun add pyric-tools
# or
npm install pyric-tools
```
## A 30-second example
```ts
import { fromServiceAccount, firestore } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');

const current = await firestore.rules.fetch(scope);
console.log(current);  // string with the deployed Firestore rules, or null
```
## Where to go next

Documentation is organised under [`docs/`](pyric-tools-deploy) following the [Diataxis](https://diataxis.fr/) framework:

| If you want to | Read |
|---|---|
| Follow a complete lesson | Tutorials |
| Accomplish a specific task | How-to guides |
| Look up a function signature, error code, or wire shape | Reference |
| Understand why the package is shaped this way | Explanation |

### Starting points by role

- **First time here?** Work through [Deploy a Cloud Function](pyric-tools-deploy-tutorials-01-deploy-a-cloud-function).
- **Setting up auth?** See [Build a `ProjectScope` from a service account](pyric-tools-deploy-how-to-build-projectscope-from-service-account).
- **Building an agent?** See [Register deploy tools with an agent](pyric-tools-deploy-how-to-register-tools-with-an-agent) and the [API reference](pyric-tools-deploy-reference-api).
- **Deploying Realtime Database rules?** See [Deploy Realtime Database rules](pyric-tools-deploy-how-to-deploy-realtime-database-rules) and the [`rtdb` namespace reference](pyric-tools-deploy-reference-rtdb-namespace).

## Position in the Pyric stack

`pyric-tools/deploy` is the **control plane**. It mutates project configuration (deploys rules, creates indexes, uploads functions). It does not read or write Firestore documents — that's `pyric/firestore` (data plane) and `pyric/rules` (rules tooling). The three packages plus `pyric/sandbox` form a loose hexagon; each depends on a small surface of the others.

See [Why this package exists](pyric-tools-deploy-explanation-why-this-package-exists) for the longer story.

## Licence

Same as the parent workspace.
