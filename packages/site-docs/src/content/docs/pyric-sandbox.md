---
title: "pyric/sandbox"
navLabel: "Overview"
group: "pyric / sandbox"
section: ""
order: 119
---
# `pyric/sandbox`

An in-process Firebase sandbox, the foundation every other `@pyric/*` data-plane package plugs into. It holds documents, rules, and listener state for a single isolated environment. It is identity-agnostic by design: every operation flows through a `SandboxContext` that names the auth identity it should evaluate under.

Three concepts:

- **`Sandbox`**: the data + rules + lifecycle handle. One per isolated environment. Also the observability surface: `onDenial`, `onSnapshotError`, and `onRequest` emit traffic events, while `reset`, `dispose`, and `snapshot` manage lifecycle.
- **`SandboxContext`**: an immutable `(sandbox, auth)` pair. Service handles (`pyric-admin`, `pyric/firestore`) accept this.
- **`SandboxError`**: a typed error family covering both Firebase-aligned codes (`permission-denied`, `not-found`) and sandbox-specific ones (`unimplemented`, `not-seeded`).

The sandbox does *not* ship the data-plane API itself. The Admin-SDK-shaped surface lives in `pyric-admin`; the modular Web-SDK surface lives in `pyric/firestore`. This package is the substrate they share.

## Install
```bash
bun add pyric/sandbox
# or
npm install pyric/sandbox
```
You will usually install one of the service-adapter packages alongside it:
```bash
bun add pyric/sandbox pyric-admin       # admin-SDK-shaped
bun add pyric/sandbox pyric/firestore   # modular Web-SDK-shaped
```
## A 30-second example
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();

const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
await aliceDb.collection('notes').doc('n1').set({ title: 'hello' });

const anonDb = getFirestore(sandbox.withAuth(null));
const snap = await anonDb.collection('notes').doc('n1').get();
console.log(snap.exists, snap.data());
```
Two contexts, one sandbox, shared data. The rules engine evaluates `aliceDb`'s write under `request.auth.uid == 'alice'`; the same writes are visible to `anonDb`'s read with `request.auth == null`.

## Where to go next

Documentation is organised under [`docs/`](../pyric-sandbox/) following the [Diataxis](https://diataxis.fr/) framework:

| If you want to | Read |
|---|---|
| Follow a complete lesson | Tutorials |
| Accomplish a specific task | How-to guides |
| Look up a method signature or error code | Reference |
| Understand the design | Explanation |

### Starting points by role

- **First time here?** Run [Your first sandbox session](../pyric-sandbox-tutorials-01-your-first-sandbox-session/).
- **Writing tests?** Read [Use the sandbox in a test harness](../test-in-node/).
- **Building an adapter?** See [The `/internal` adapter protocol](../pyric-sandbox-explanation-internal-adapter-protocol/).

## Position in the Pyric stack

`pyric/sandbox` is the **runtime substrate**. It does not depend on `pyric-admin`, `pyric/firestore`, or any other adapter. They depend on it. Rules tooling lives in `pyric/rules` (imported by the sandbox for `SimulateFirestoreRulesHandler`). Control-plane operations live in `pyric-tools/deploy`. See [Why this package exists](../pyric-sandbox-explanation-why-this-package-exists/).

## Licence

Same as the parent workspace.
