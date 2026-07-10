---
title: "Deploy a Cloud Function"
group: "pyric-tools / deploy"
section: "Tutorials"
order: 48
---
# Deploy a Cloud Function

In this tutorial you will use `pyric-tools/deploy` to deploy a small Cloud Function Gen 2 to a Firebase project. By the end you will have:

1. Built a `ProjectScope` from a service-account JSON.
2. Bundled a local source directory.
3. Deployed the function and seen its public URL.
4. Watched a deliberate failure to learn what the result shape looks like.

This tutorial uses Bun, but every step works identically with `node` and `npm`.

## Before you start

You need:

- A Firebase / Google Cloud project where Cloud Functions has been enabled.
- A service-account JSON file with the **Firebase Admin** role and **Service Account User** role.
- Node 20+ or Bun 1.x.

## Step 1 — Set up a working folder
```bash
mkdir deploy-tutorial && cd deploy-tutorial
bun init -y
bun add pyric-tools
```
## Step 2 — Write the function source

Create a `functions/` subdirectory and add `functions/package.json`:
```json
{
  "name": "tutorial-functions",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "engines": { "node": "22" },
  "dependencies": {}
}
```
Add `functions/index.js`:
```js
export function hello(req, res) {
  res.json({ message: 'Hello from pyric-tools/deploy', when: new Date().toISOString() });
}
```
Two files — that's the whole function. The bundler will zip it, the Cloud Build buildpack will install dependencies (there are none), and Cloud Functions will run `hello` on HTTP requests.

## Step 3 — Deploy it

Save your service-account JSON as `service-account.json` next to your `package.json` (or set it through an env var — `fromServiceAccount` accepts both).

Create `deploy.ts`:
```ts
import { fromServiceAccount, functions } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
console.log(`Project: ${scope.projectId}`);

const result = await functions.deployLocal(scope, {
  localDir: './functions',
  functions: [
    {
      id: 'hello',
      entryPoint: 'hello',
      region: 'us-central1',
      memory: '256Mi',
      invoker: 'public',
    },
  ],
});

if (result.success) {
  for (const fn of result.data.deployed) {
    console.log(`Deployed ${fn.id} → ${fn.uri} (public: ${fn.publicInvoker})`);
  }
} else {
  console.error(`[${result.error.code}] ${result.error.message}`);
}
```
Run it:
```bash
bun run deploy.ts
```
The first deploy takes a few minutes — the bundler zips the directory, the upload uses a Cloud Build signed URL, and the function build itself takes ~30–90 seconds. When it completes you will see:
```
Project: your-project-id
Deployed hello → https://hello-<hash>-uc.a.run.app (public: true)
```
That URL is the function's Cloud Run endpoint. Open it in a browser:
```json
{ "message": "Hello from pyric-tools/deploy", "when": "2026-05-12T20:00:00.000Z" }
```
The function is live.

## Step 4 — Re-deploy

Edit `functions/index.js` and change the message. Re-run `bun run deploy.ts`. This time the deploy is faster — Cloud Build re-uses the dependency layer because `package.json` is unchanged. The bundler still uploads the new source.

## Step 5 — Watch a failure

Edit `deploy.ts` and change `entryPoint: 'hello'` to `entryPoint: 'missing'`. Run again:
```
[OPERATION_FAILED] Function deployment operation failed: ...
```
The deploy was issued, the source uploaded, Cloud Build ran — and then the function failed to load because the export doesn't exist. The error code `OPERATION_FAILED` signals "the operation completed with an error" (as opposed to `CREATE_FAILED`, which would mean the create call itself returned non-2xx).

`result.error.functionIndex` tells you which function in the array failed. In a multi-function deploy, earlier functions may already be live — the array isn't transactional.

Fix the entry point and re-run. Five for five.

## What you have learned

- `fromServiceAccount` builds a `ProjectScope` with internally-cached token resolution.
- `functions.deployLocal` bundles a Node source directory and deploys one or more functions from it.
- The result shape is `{ success: true, data: { deployed } } | { success: false, error }` — branch on `success` first.
- `FunctionsErrorCode` carries enough information to distinguish "build failed" from "create failed" from "operation failed".

## What to do next

The function is reachable at its Cloud Run URL. To route it through Firebase Hosting (so it appears as `/api/hello` on your domain), follow [How to deploy Hosting rewrites](../pyric-tools-deploy-how-to-deploy-hosting-rewrites/). To expose the deploy through an agent, see [Register deploy tools with an agent](../pyric-tools-deploy-how-to-register-tools-with-an-agent/).
