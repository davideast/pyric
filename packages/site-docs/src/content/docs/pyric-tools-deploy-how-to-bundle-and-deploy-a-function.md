---
title: "How to bundle and deploy a Cloud Function"
group: "pyric-tools / deploy"
section: "How-to"
order: 19
---
# How to bundle and deploy a Cloud Function

This guide shows you how to deploy one or more Cloud Functions Gen 2 from a source directory.

## One-call deploy (Node)
```ts
import { functions } from 'pyric-tools/deploy';

const result = await functions.deployLocal(scope, {
  localDir: './functions',
  functions: [
    {
      id: 'api',
      entryPoint: 'apiHandler',
      region: 'us-central1',
      memory: '512Mi',
      timeoutSeconds: 60,
      invoker: 'public',
    },
  ],
});

if (result.success) {
  for (const fn of result.data.deployed) {
    console.log(`${fn.id} → ${fn.uri} (public: ${fn.publicInvoker})`);
  }
} else {
  console.error(`[${result.error.code}] ${result.error.message}`);
  if (result.error.functionIndex !== undefined) {
    console.error(`Failed at index ${result.error.functionIndex}`);
  }
}
```
`deployLocal` does three things: zips the source via `bundleFunctionSource`, uploads it, and creates each function in turn. The same source bundle deploys to every function in the array — one upload, multiple creates.

## What gets bundled

The default ignore set, applied recursively:

- `node_modules/`, `dist/`, `lib/`, `build/`, `out/`, `coverage/`
- `.git/`, `.DS_Store`, `*.log`
- Hidden files at any depth

The bundler also slims `package.json` by default:

- Strips `devDependencies` (Cloud Build's buildpack errors on missing dev deps).
- Strips `scripts.build` / `build:watch` / `prebuild` / `postbuild` (the buildpack runs these by default; ship pre-compiled JS in `lib/` instead).
- Drops `package-lock.json` (incompatible with the stripped deps; the buildpack falls back to `npm install --omit=dev`).

Pass `slim: false` to the lower-level `bundleFunctionSource` to ship `package.json` verbatim.

## From a browser host (or any zip source)

Skip `deployLocal` and use `deploy` with a pre-built bundle:
```ts
import { functions } from 'pyric-tools/deploy';

const result = await functions.deploy(scope, {
  sourceZip: yourZipBytes,       // Uint8Array
  defaultRuntime: 'nodejs22',
  functions: [
    { id: 'api', entryPoint: 'apiHandler' },
  ],
});
```
The zip layout must match what Cloud Build's buildpack expects: a `package.json` at the root, `index.js` (or `lib/index.js`) exporting the named `entryPoint`.

## Make a function publicly invokable

Set `invoker: 'public'` on the function config. After the function lands, the package issues `grantPublicInvoker` automatically. If that grant fails (most commonly because the service account lacks `roles/iam.serviceAccountUser`), the deploy completes but returns `IAM_GRANT_FAILED` — the function exists but is private.

For more control, omit `invoker` (defaults to `'private'`) and call `functions.grantPublicInvoker(scope, ...)` separately.

## Wait for the operation

`deployLocal` already waits for each function's create operation to complete and populates `DeployedFunction.uri` from the result. You only need to poll manually if you're calling lower-level primitives directly:
```ts
import { functions } from 'pyric-tools/deploy';

const op = await functions.pollOperation(scope, operationName, {
  intervalMs: 5_000,
  timeoutMs: 5 * 60_000,
});
```
## Required IAM

- `cloudfunctions.functions.create` / `update`
- `cloudbuild.builds.create`
- `iam.serviceAccounts.actAs` (for the runtime service account)
- `run.services.setIamPolicy` (only for `invoker: 'public'`)

The simplest grant is **Firebase Admin** + **Service Account User**.

## Where to look next

- For the full `FunctionDeployConfig` field list, see [`functions` namespace — `FunctionDeployConfig`](pyric-tools-deploy-reference-functions-namespace#functiondeployconfig).
- For routing URLs to the deployed function, see [Deploy Hosting rewrites](pyric-tools-deploy-how-to-deploy-hosting-rewrites).
- For the matching error codes, see [Error codes by operation — Cloud Functions](pyric-tools-deploy-reference-error-codes#cloud-functions).
