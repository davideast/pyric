---
title: "Sandbox test driver: pyric/auth/sandbox.*"
navLabel: "Sandbox test driver"
group: "pyric / auth"
section: "Reference"
order: 15002
---
# Sandbox test driver: `pyric/auth/sandbox.*`

The `sandbox` export is `pyric/auth`'s test-driver namespace. It mirrors `pyric/firestore`'s `sandbox.setRules` / `sandbox.seedDocuments` pattern: methods exist only for sandbox-backed `Auth` handles and throw `failed-precondition` against a prod handle.

```ts
import { sandbox as authSandbox } from 'pyric/auth';
```

The import alias avoids the name collision with the local `const sandbox = initializeSandbox()` you'll typically have in scope.

---

## `sandbox.setUser(auth, user | null)`

Force the current user. Bypasses email/password lookup, mock-result registry, and seeded DB. Pass `null` to sign out.

```ts
authSandbox.setUser(auth, {
  uid: 'forced-uid',
  email: 'forced@example.com',
  displayName: 'Forced User',
  isAnonymous: false,
  getIdToken: async () => 'fake-token',
  getIdTokenResult: async () => ({
    token: 'fake-token',
    claims: { role: 'admin' },
    expirationTime: new Date(Date.now() + 3600_000).toISOString(),
    issuedAtTime: new Date().toISOString(),
    authTime: new Date().toISOString(),
  }),
});
```

Emits to `onAuthStateChanged` / `onIdTokenChanged` subscribers and writes through to `sandbox.currentUser`.

---

## `sandbox.mockSignInResult(auth, result)`

Pre-stage the result that the next matching `signInWithPopup` / `signInWithCredential` call returns. The mock is **one-shot**, consumed by the next call with the matching `providerId`. Stage again for repeat tests.

```ts
authSandbox.mockSignInResult(auth, {
  user: makeGoogleUser('uid-1', 'a@example.com'),
  providerId: 'google.com',
  operationType: 'signIn',
});

await signInWithPopup(auth, new GoogleAuthProvider());
// → resolves to the mock, sets currentUser to mock.user

await signInWithPopup(auth, new GoogleAuthProvider());
// → throws auth/no-mock-configured
```

The provider passed to `signInWithPopup` must have a `providerId` that matches `result.providerId`.

---

## `sandbox.seedUsers(auth, users)`

Bulk-load test users for email/password lookup. Each record:

```ts
interface SeedUser {
  uid: string;
  email: string;
  password: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
}
```

```ts
authSandbox.seedUsers(auth, [
  { uid: 'alice', email: 'alice@example.com', password: 'pw1' },
  {
    uid: 'admin',
    email: 'admin@example.com',
    password: 'pw2',
    displayName: 'Admin User',
    customClaims: { role: 'admin', tier: 5 },
  },
]);

await signInWithEmailAndPassword(auth, 'admin@example.com', 'pw2');
// auth.currentUser.uid === 'admin'
// (await auth.currentUser.getIdTokenResult()).claims.role === 'admin'
```

`customClaims` flow through into `sandbox.currentUser.token`, which is what the Firestore rules engine reads as `request.auth.token.*`. This is the seam that makes rules tests with custom claims work end-to-end on sandbox.

Email lookup is case-insensitive. Re-seeding the same uid overwrites.

---

## Errors

These helpers require an `Auth` handle produced by `pyric/auth`. Production
code remains on `firebase/auth` and does not load the sandbox driver.

`sandbox.mockSignInResult` additionally throws `'invalid-argument'` if `result.providerId` is missing. The mock registry is keyed on `providerId`, so an unkeyed mock can't be matched.

---

## What's NOT a test driver

The `firebase/auth` SDK has no equivalent of these methods, so they're sandbox-only. The agent's deployed `appSource` must never import the `sandbox` namespace. Keep it in the runner harness (the `code` artifact in playground), not in app code. The deploy adapter's metafile gate rejects any prod bundle containing `@pyric/*`.
