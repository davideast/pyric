---
title: "pyric/auth"
navLabel: "Overview"
group: "pyric / auth"
section: ""
order: 15001
---
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
## What's in v0

The deliberately-minimal surface covers everything an `appSource` likely needs:

- `getAuth(target)`: default sandbox app, `Sandbox`, and sandbox-backed `PyricApp` overloads
- `connectAuthEmulator(auth, url, options?)`: accepted no-op because the mirror is already a sandbox
- `signInAnonymously` / `signInWithEmailAndPassword` / `createUserWithEmailAndPassword` / `signOut`
- `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`: sandbox returns pre-staged mock results
- `setPersistence` + `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence`
- `onAuthStateChanged` / `onIdTokenChanged`
- Provider classes: `GoogleAuthProvider`, `EmailAuthProvider`, `FacebookAuthProvider`, `GithubAuthProvider`, `OAuthProvider`
- Sandbox-only test driver: `sandbox.setUser`, `sandbox.mockSignInResult`, `sandbox.seedUsers`

See [`docs/reference/feature-matrix.md`](../pyric-auth-reference-feature-matrix/) for the full feature matrix and the explicit v0 deny-list.

## What's out (v0)

Unsupported symbols fail to resolve only in sandbox builds where package resolution selects this mirror. Production remains on the complete `firebase/auth` package. The current list is maintained in the feature matrix.

## State model: sandbox-wide `currentUser`

`pyric/auth`'s sandbox backend writes through to `sandbox.currentUser`. Every sandbox now carries that field plus an `onCurrentUserChanged` event. This is the integration seam: a future `getFirestore(sandbox)` overload reads `sandbox.currentUser` per-call so Firestore rules evaluate against the live auth state without re-binding handles.

Today, `pyric/auth` writes to the field; reading from other service handles is the next follow-up.

## What's next (deferred follow-ups)

- **`getFirestore(sandbox)` per-call identity read.** Add a `(sandbox)` overload on `pyric/firestore`'s `getFirestore` that reads `sandbox.currentUser` for each op. Lets agent code call `getFirestore(sandbox)` once and have Firestore see auth changes from `pyric/auth`'s sign-in flows automatically.
- **Agent system-prompt update.** Drop the "no `firebase/auth` in `appSource`" rule and document the v0 deny-list as the new boundary.

## Position in the Pyric stack

`pyric/auth` is the **modular-shape auth adapter**, sibling to `pyric/firestore`. Both run on top of `pyric/sandbox` and share the same `currentUser` bridge.

## Licence

Same as the parent workspace.
