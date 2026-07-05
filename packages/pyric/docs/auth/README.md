# `pyric/auth`

Modular Web SDK Auth adapter for the Pyric sandbox. Mirrors `firebase/auth`'s tree-shakable shape — `getAuth`, `signInAnonymously`, `signInWithEmailAndPassword`, `onAuthStateChanged`, `signInWithPopup`, `GoogleAuthProvider` — with two backends picked at init time:

- **Sandbox** (`pyric/sandbox`) — in-process, browser-safe, no network. Drives `sandbox.currentUser` so downstream service handles can read identity per-call.
- **Prod** (`firebase/auth`) — the real Firebase Auth.

Same call sites, two different backends. Swap by changing what you pass to `getAuth`.

## Install

```bash
bun add pyric/auth pyric/sandbox firebase
```

`firebase` is required because the prod backend dispatches to it. Bundlers tree-shake away the prod path when only the sandbox backend is reached.

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

Prod backend — the same code with a different `getAuth` argument:

```ts
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'pyric/auth';

const app = initializeApp({ /* your Firebase config */ });
const auth = getAuth(app);

await signInWithEmailAndPassword(auth, 'alice@example.com', 'pw');
```

## What's in v0

The deliberately-minimal surface covers everything an `appSource` likely needs:

- `getAuth(target)` — `(sandbox)` and `(app)` overloads
- `connectAuthEmulator(auth, url, options?)` — no-op on sandbox; delegates on prod
- `signInAnonymously` / `signInWithEmailAndPassword` / `createUserWithEmailAndPassword` / `signOut`
- `signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)` — sandbox returns pre-staged mock results
- `setPersistence` + `inMemoryPersistence` / `browserSessionPersistence` / `browserLocalPersistence`
- `onAuthStateChanged` / `onIdTokenChanged`
- Provider classes: `GoogleAuthProvider`, `EmailAuthProvider`, `FacebookAuthProvider`, `GithubAuthProvider`, `OAuthProvider`
- Sandbox-only test driver: `sandbox.setUser`, `sandbox.mockSignInResult`, `sandbox.seedUsers`

See [`docs/reference/feature-matrix.md`](./docs/reference/feature-matrix.md) for the full feature matrix and the explicit v0 deny-list.

## What's out (v0)

Multi-factor, phone auth, redirect flows, link/unlink, profile mutation, password reset / email verification, custom-token sign-in, tenant manager. Code that imports these symbols will fail to bundle once the playground's `firebase/auth` → `pyric/auth` alias swap lands. Full list in the feature matrix.

## State model: sandbox-wide `currentUser`

`pyric/auth`'s sandbox backend writes through to `sandbox.currentUser`. Every sandbox now carries that field plus an `onCurrentUserChanged` event. This is the integration seam: a future `getFirestore(sandbox)` overload reads `sandbox.currentUser` per-call so Firestore rules evaluate against the live auth state without re-binding handles.

Today, `pyric/auth` writes to the field; reading from other service handles is the next follow-up.

## What's next (deferred follow-ups, not in this PR)

- **`getFirestore(sandbox)` per-call identity read.** Add a `(sandbox)` overload on `pyric/firestore`'s `getFirestore` that reads `sandbox.currentUser` for each op. Lets agent code call `getFirestore(sandbox)` once and have Firestore see auth changes from `pyric/auth`'s sign-in flows automatically.
- **Playground alias swap.** Add `firebase/auth` → `pyric/auth` to the playground-next preview build's esbuild aliases.
- **Agent system-prompt update.** Drop the "no `firebase/auth` in `appSource`" rule and document the v0 deny-list as the new boundary.

## Position in the Pyric stack

`pyric/auth` is the **modular-shape auth adapter**, sibling to `pyric/firestore`. Both run on top of `pyric/sandbox` and share the same `currentUser` bridge.

## Licence

Same as the parent workspace.
