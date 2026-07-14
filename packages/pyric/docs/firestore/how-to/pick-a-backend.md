# How to select sandbox or production Firestore

Keep canonical Firebase imports in application source and select the backend by
activating, or not activating, Pyric's package-resolution seam.

## Keep one application module

```ts
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const app = initializeApp({ projectId: 'your-project-id' });
export const db = getFirestore(app);
```

Do not add an environment conditional around `getFirestore`. The import
resolver makes the choice before this module executes.

## Run against production

Run the application normally. Do not install a Pyric Vite plugin, preload the
register hook, or set `PYRIC_SANDBOX`:

```bash
node app.mjs
```

`firebase/app` and `firebase/firestore` remain the real Firebase packages.

## Run the same source in the Node sandbox

Let `pyric dev` activate the resolver for the child command:

```bash
pyric dev -- node app.mjs
```

The hook rewrites the canonical imports to `pyric/app` and
`pyric/firestore`. The configuration object is retained for source
compatibility but does not select a real project.

## Run the same source through Vite

```ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [pyricSandbox()],
});
```

`vite dev` activates the swap. A normal `vite build` leaves it inactive and
produces the Firebase build.

## Construct an explicit test sandbox

Use direct Pyric imports only when the test needs to control identity or
sandbox state explicitly:

```ts
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';

const sandbox = initializeSandbox();
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
```

Do not pass a real `FirebaseApp` to `pyric/firestore`. The direct module is a
sandbox-only mirror and rejects that input.

## Verify the selected backend

Prefer behavioural verification over reading internal brands:

- In the sandbox, a write and read complete without contacting Firebase.
- Without activation, normal Firebase configuration and network behaviour
  apply.
- In CI, run both the inactive register probe and an active canonical-import
  smoke test.

For the reasoning behind this boundary, see
[Why package resolution owns backend selection](../explanation/two-backends-one-surface.md).
