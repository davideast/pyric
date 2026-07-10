---
title: Sign users in and manage them
navLabel: Sign in and manage users
outcome: Run real auth flows against a local user database, seed test users with claims, and design an identity model your rules can trust.
status: draft
---

# Sign users in

The auth code you would write against Firebase works as-is under `pyric dev`, and the users it creates live in your sandbox. Auth is v1 in Pyric: the surface is tested against recorded production behavior, so what signs in here signs in there.

```ts
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const auth = getAuth(app);

onAuthStateChanged(auth, (user) => {
  render(user ? `Signed in as ${user.uid}` : 'Signed out');
});

await signInAnonymously(auth);
```

Email and password work the way you expect, creation and sign-in as separate flows:

```ts
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';

await createUserWithEmailAndPassword(auth, 'alice@example.com', 'correct-horse');
await signInWithEmailAndPassword(auth, 'alice@example.com', 'correct-horse');
```

And the Google flow:

```ts
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

await signInWithPopup(auth, new GoogleAuthProvider());
```

Under `pyric dev`, that call opens an account picker instead of a Google window. Pick an existing sandbox identity or create one on the spot, with a display name and custom claims if you want them. No OAuth app, no consent screen, and the identity flows into your rules like any other. `signInWithRedirect` and `getRedirectResult` follow the same path.

## Manage users in the sandbox

The user database is local state, so you can load it. In a test harness or seed script, `seedUsers` bulk-loads identities, claims included:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInWithEmailAndPassword, sandbox as authSandbox } from 'pyric/auth';

const sandbox = initializeSandbox();
const auth = getAuth(sandbox);

authSandbox.seedUsers(auth, [
  { uid: 'alice', email: 'alice@example.com', password: 'pw' },
  { uid: 'admin', email: 'admin@example.com', password: 'pw', customClaims: { role: 'admin' } },
]);

await signInWithEmailAndPassword(auth, 'admin@example.com', 'pw');
```

To flip between identities without a sign-in flow, `setUser` forces the current user directly (it takes a full user object) and notifies `onAuthStateChanged` subscribers like a real sign-in. Pass `null` to sign out:

```ts
authSandbox.setUser(auth, aliceUser);
authSandbox.setUser(auth, null);
```

Keep the `sandbox` namespace out of app source. The real `firebase/auth` has no equivalent, so it belongs in your harness and seed code, where switching users mid-test is the point. In the running app, the account picker and `pyric snapshot` cover the same ground: lived users can be promoted to a committable fixture and re-seeded on boot.

## Design an identity model

Authentication answers who the user is. Rules answer what that identity may do. Connecting the two is a design task, and it has three moves.

**Name your identities.** Anonymous visitor, signed-in user, owner, member, admin. Every access boundary in your app should map to one of these names before any rule mentions it.

**Make the UID the bridge.** The `uid` is the stable key that connects Authentication to your data. Put profile documents at `users/{uid}`, use the UID as the document ID wherever a record belongs to one person, and decide early which profile fields are public and which are private.

**Split claims from roles data.** Custom claims carry coarse, global, slow-changing roles (`admin`, `moderator`), and rules read them as `request.auth.token.role`. Membership, ownership, and anything resource-specific belongs in document data, where a rule can `get()` it. One caution that pays for itself: users must never be able to grant themselves a role through a writable profile field. Your rules have to protect the shape of profile creates and updates, not only who performs them.

## How identity reaches your rules

Every operation in the sandbox carries `request.auth`, exactly as production rules see it:

```
match /posts/{postId} {
  allow update, delete: if request.auth != null
    && (request.auth.uid == resource.data.ownerId
        || request.auth.token.role == 'admin');
}
```

`request.auth` is `null` when nobody is signed in. `request.auth.uid` is the owner check. `request.auth.token.*` carries the custom claims, and the claims you pass to `seedUsers` flow through to it end to end, so a rules test with an admin claim exercises the same path production will. When a rule denies, the verdict names the rule and the data it saw. [Prove your rules protect the app](../secure/secure-it-with-rules.md) picks up from here.

## The boundaries, plainly

Phone auth, email-link sign-in, multi-factor, account linking, and password-reset emails are not in v1. Code that reaches for them fails loudly rather than pretending. The full deny list lives in the reference, and every entry throws with a remediation message instead of returning bad data.

## And from an agent

The `firebase-auth-model` skill designs or audits an identity model end to end: it names the actors, maps UIDs to data shapes, weighs claims against document roles, and then verifies each rule branch by simulating the identities it defined. Point it at an existing app and it reports where the model and the rules disagree. Install it from the [skills catalog](../agent/skills.md).

## Where to go next

Your users exist and your rules can see them. [Store and query data](./store-and-query-data.md) puts them to work, and [secure it with rules](../secure/secure-it-with-rules.md) proves what they can touch.
