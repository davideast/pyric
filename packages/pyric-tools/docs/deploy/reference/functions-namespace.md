# `functions` namespace

Cloud Functions Gen 2 deploy primitives. Every method takes a `ProjectScope` first.

```ts
import { functions } from 'pyric-tools/deploy';
```

## `functions.deployLocal(scope, options)`

Bundle a local source directory and deploy. Convenience for the most common shape: one source bundle, one or more functions deployed from it.

```ts
async function deployLocal(
  scope: ProjectScope,
  options: DeployFunctionsLocalOptions,
): Promise<DeployFunctionsResult>;

interface DeployFunctionsLocalOptions {
  localDir: string;
  functions: FunctionDeployConfig[];
}
```

The bundler (`bundleFunctionSource`) is Node-only. For browser hosts, use `functions.deploy` with a pre-built zip.

## `functions.deploy(scope, input)`

Deploy a pre-built bundle. Use when you manage bundling separately.

```ts
async function deploy(
  scope: ProjectScope,
  input: Omit<DeployFunctionsCoreInput, 'accessToken' | 'projectId'>,
): Promise<DeployFunctionsResult>;
```

The `input` carries `sourceZip: Uint8Array`, `defaultRuntime`, and `functions: FunctionDeployConfig[]`.

## `functions.bundle(localDir)`

Bundle source for a Cloud Function. Pure-Node (esbuild + fflate).

```ts
function bundle(localDir: string): BundleResult;

interface BundleResult {
  zip: Uint8Array;
  files: string[];      // relative POSIX paths included
  runtime: string;      // inferred 'nodejs<major>', fallback 'nodejs22'
}
```

Default ignore set keeps the bundle small without a `.gcloudignore`: `node_modules/`, `dist/`, `lib/`, `build/`, `out/`, `coverage/`, `.git/`, `.DS_Store`, `*.log`, and hidden files at any depth.

`BundleOptions` (when called via the lower-level bundler):

- `slim: boolean` — default `true`. Rewrites `package.json` to drop `devDependencies` and build-related scripts, and drops `package-lock.json` so the Cloud Build buildpack falls back to `npm install --omit=dev`.

## `functions.pollOperation(scope, operationName, opts?)`

Poll a long-running Cloud Functions operation. Use when you want to wait for a function deploy to fully complete.

```ts
async function pollOperation(
  scope: ProjectScope,
  operationName: string,
  opts?: PollOptions,
): Promise<PollResult>;

interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}
```

`DeployFunctionsResult.data.deployed[].uri` is populated as each function finishes its operation; you only need `pollOperation` when you want to introspect intermediate state.

## `functions.grantPublicInvoker(scope, input)`

Grant `roles/run.invoker` to `allUsers` for a function. Required for public HTTP invocation.

```ts
async function grantPublicInvoker(
  scope: ProjectScope,
  input: { region: string; serviceId: string },
): Promise<IamGrantResult>;
```

`serviceId` is the Cloud Run service the function landed on — usually the same as the function id, but check `DeployedFunction.uri` when in doubt.

## `FunctionDeployConfig`

```ts
interface FunctionDeployConfig {
  id: string;                            // URL-safe, matches rewrite functionId
  entryPoint: string;                    // exported symbol the runtime invokes
  region?: string;                       // default 'us-central1'
  runtime?: string;                      // default inferred from engines.node, fallback 'nodejs22'
  memory?: string;                       // default '256Mi'
  timeoutSeconds?: number;               // default 60, max 3600
  minInstances?: number;                 // default 0
  maxInstances?: number;                 // default 100
  invoker?: 'public' | 'private';        // default 'private'
}
```

Setting `invoker: 'public'` triggers a `grantPublicInvoker` after the function is live.

## `DeployFunctionsResult`

```ts
type DeployFunctionsResult =
  | { success: true; data: DeployFunctionsSuccess }
  | { success: false; error: DeployFunctionsError };

interface DeployFunctionsSuccess {
  deployed: DeployedFunction[];   // one per function in input, order preserved
}

interface DeployedFunction {
  id: string;
  region: string;
  uri: string;             // full Cloud Run URI
  publicInvoker: boolean;
}

interface DeployFunctionsError {
  code: FunctionsErrorCode;
  message: string;
  recoverable: boolean;
  functionIndex?: number;  // which function in the input array triggered the failure
}

type FunctionsErrorCode =
  | 'INVALID_INPUT'
  | 'PERMISSION_DENIED'
  | 'SOURCE_BUNDLE_FAILED'
  | 'UPLOAD_URL_FAILED'
  | 'UPLOAD_FAILED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'OPERATION_TIMED_OUT'
  | 'OPERATION_FAILED'
  | 'IAM_GRANT_FAILED'
  | 'NETWORK_ERROR';
```

`functionIndex` is present when a specific function in a multi-function deploy failed; earlier entries in the array may have deployed successfully.
