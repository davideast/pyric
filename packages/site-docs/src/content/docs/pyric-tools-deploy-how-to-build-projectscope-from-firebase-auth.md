---
title: "How to build a ProjectScope from Firebase Auth (browser)"
navLabel: "Scope from Firebase Auth"
group: "pyric-tools / deploy"
section: "How-to"
order: 49
---
# How to build a `ProjectScope` from Firebase Auth (browser)

This guide shows you how to build a `ProjectScope` in a browser host using the currently-signed-in Firebase Auth user.

## The shape

`ProjectScope` is `{ projectId, resolveToken }`. Wire it by hand:
```ts
import type { ProjectScope } from 'pyric-tools/deploy';
import { getAuth } from 'firebase/auth';

const auth = getAuth();

const scope: ProjectScope = {
  projectId: 'your-project-id',
  resolveToken: () => auth.currentUser!.getIdToken(),
};
```
`getIdToken()` caches and refreshes internally, so you don't need `memoizeTtl` on top.

## Add a wait-for-sign-in guard

`auth.currentUser` is `null` until the auth state has resolved. Wrap the resolver:
```ts
import { onAuthStateChanged } from 'firebase/auth';

async function waitForUser() {
  return new Promise<void>((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        unsubscribe();
        resolve();
      }
    });
  });
}

const scope: ProjectScope = {
  projectId: 'your-project-id',
  resolveToken: async () => {
    if (!auth.currentUser) await waitForUser();
    return auth.currentUser!.getIdToken();
  },
};
```
This pattern means primitives called immediately after page load will block on auth instead of throwing.

## What works and what doesn't from a browser

Most primitives in `pyric-tools/deploy` use only `fetch` and work from a browser:

- All `firestore.rules.*` calls.
- All `firestore.indexes.*` and `firestore.databases.*` calls.
- `hosting.deployFiles` *when you supply pre-walked `files`*, not when you pass `localDir` (Node-only).
- `hosting.sites.{create, ensure}`.
- `functions.deploy` *when you supply a pre-built zip*, not `functions.deployLocal` or `functions.bundle` (Node-only).
- `functions.pollOperation` and `functions.grantPublicInvoker`.

A browser host that ships an already-bundled functions zip from any source (a build server, a file upload UI, an in-memory esbuild bundle) can still deploy without leaving the browser.

## Required scopes

Firebase ID tokens already carry the right OAuth scopes for these operations *when* the project has enabled the relevant APIs. If a call returns 403, the most common cause is the IAM role on the signed-in user, not the token. Grant the user **Firebase Admin** (or the per-API equivalents) and re-issue the token.

## Where to look next

- Working in Node with a service account instead? See [Build a `ProjectScope` from a service account](../pyric-tools-deploy-how-to-build-projectscope-from-service-account/).
- Want to understand the resolver pattern (why `resolveToken` is a function, not a value)? See [Token caching and `memoizeTtl`](../pyric-tools-deploy-explanation-token-caching/).
