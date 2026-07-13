# `pyric/firestore`

`pyric/firestore` is the sandbox implementation of Firebase's modular
Firestore surface. It provides reads, writes, queries, listeners,
transactions, batches, converters, aggregates, sentinels, and local scalar
value classes without loading the production Firebase SDK.

Backend selection belongs to package resolution:

- Without Pyric activation, `firebase/firestore` is Firebase.
- With `pyric dev`, the Vite plugin, or `@pyric/cli/register` active,
  `firebase/firestore` resolves to the Pyric sandbox mirror.
- A direct `pyric/firestore` import is always sandbox-only.

## Canonical application code

Keep Firebase imports in application code:

```ts
import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

const app = initializeApp({ projectId: 'demo-project' });
const db = getFirestore(app);
const ref = doc(db, 'notes/n1');

await setDoc(ref, { title: 'hello' });
console.log((await getDoc(ref)).data());
```

Run the same source in a Node sandbox:

```bash
PYRIC_SANDBOX=local node --import @pyric/cli/register app.mjs
```

Or activate the Vite integration:

```ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({ plugins: [pyricSandbox()] });
```

With neither activation seam present, the imports remain Firebase and use the
real project configured by `initializeApp`.

## Direct sandbox construction

Tests and sandbox tooling may construct a handle explicitly:

```ts
import { getFirestore, doc, setDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
await setDoc(doc(db, 'notes/n1'), { title: 'hello' });
```

Passing a real `FirebaseApp` to this direct mirror is an error. Production code
must load `firebase/firestore` without sandbox activation.

## Position in the Pyric stack

`pyric/firestore` is the modular client data plane. Firestore sandbox controls
live under `pyric/sandbox/firestore`; rules evaluation lives under
`pyric/rules`; and production deployment is a separate tooling concern.

See the [how-to guides](./how-to/), [reference](./reference/), and
[explanations](./explanation/) for the next level of detail.
