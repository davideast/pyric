# `pyric/auth`

Sandbox-only modular Web SDK Auth mirror. It implements `firebase/auth`'s tree-shakable shape (`getAuth`, `signInAnonymously`, `signInWithEmailAndPassword`, `onAuthStateChanged`, `signInWithPopup`, `GoogleAuthProvider`) in process, with no network.

Application code keeps canonical `firebase/auth` imports. Pyric's Vite/import-map or Node register boundary swaps those imports to this mirror in sandbox mode; production installs no swap and continues loading Firebase itself. Direct `pyric/auth` imports always select sandbox behavior.

## Install

```bash
bun add pyric firebase
```

`firebase` supplies the canonical production package. It is not a runtime dependency of the `pyric/auth` mirror.

## A 30-second example

Sandbox backend:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, sandbox as authSandbox } from 'pyric/auth';

const sandbox = initializeSandbox();
const auth = getAuth(sandbox);

authSandbox.seedUsers(auth, [
  { uid: 'alice', email: 'alice@example.com', password: 'pw', customClaims: { role: 'admin' } },
]);

onAuthStateChanged(auth, (user) => {
  console.log('current user:', user?.uid ?? '(signed out)');
});

await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw');
console.log(auth.currentUser?.uid); // 'alice'
```

Production uses the canonical package without a Pyric swap:

```ts
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

const app = initializeApp({ /* your Firebase config */ });
const auth = getAuth(app);

await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw');
```

## Check feature support

Auth support changes as the mirror grows, so this documentation does not maintain a second allow-list or deny-list. Query the central conformance model for the current availability, fidelity, assurance, caveats, and evidence:

```bash
pyric can-i-use auth/signInWithEmailLink
pyric can-i-use auth/linkWithCredential
```

Unsupported symbols fail to resolve only in sandbox builds where package resolution selects this mirror. Production remains on the complete `firebase/auth` package.

## State model: sandbox-wide `currentUser`

`pyric/auth`'s sandbox backend writes through to `sandbox.currentUser`. Every sandbox now carries that field plus an `onCurrentUserChanged` event. This is the integration seam: a future `getFirestore(sandbox)` overload reads `sandbox.currentUser` per-call so Firestore rules evaluate against the live auth state without re-binding handles.

Today, `pyric/auth` writes to the field; reading from other service handles is the next follow-up.

## What's next (deferred follow-ups)

- **`getFirestore(sandbox)` per-call identity read.** Add a `(sandbox)` overload on `pyric/firestore`'s `getFirestore` that reads `sandbox.currentUser` for each op. Lets agent code call `getFirestore(sandbox)` once and have Firestore see auth changes from `pyric/auth`'s sign-in flows automatically.
- **Agent system-prompt update.** Drop the "no `firebase/auth` in `appSource`" rule and query the conformance model before selecting a feature.

## Position in the Pyric stack

`pyric/auth` is the **modular-shape auth adapter**, sibling to `pyric/firestore`. Both run on top of `pyric/sandbox` and share the same `currentUser` bridge.

## Licence

Same as the parent workspace.
