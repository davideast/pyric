---
title: "hosting namespace"
group: "pyric-tools / deploy"
section: "Reference"
order: 65
---
# `hosting` namespace

Firebase Hosting deploy primitives. Every method takes a `ProjectScope` as its first argument and resolves the token internally per-dispatch.
```ts
import { hosting } from 'pyric-tools/deploy';
```
## `hosting.deployFiles(scope, options)`

Deploy a directory of files to a Hosting site.
```ts
async function deployFiles(
  scope: ProjectScope,
  options: DeployHostingScopedOptions,
): Promise<DeployHostingResult>;

interface DeployHostingScopedOptions {
  siteId: string;
  localDir?: string;          // Node: walks the directory
  ignore?: string[];          // ignore globs for the walk (defaults below)
  files?: WalkedFile[];       // Browser: pre-walked file list (ignore not applied)
  config?: HostingJsonConfig; // firebase.json hosting block → version serving config
  channelId?: string;         // preview channel; omit (or 'live') for live
  channelTtl?: string;        // protobuf Duration ('604800s'); create only
}
```
`ignore` takes firebase.json hosting `ignore` globs; omitted, it
applies the firebase-tools scaffold defaults (`firebase.json`,
`**/.*`, `**/node_modules/**`). See
[firebase.json hosting config](../pyric-tools-deploy-reference-hosting-config/#ignore-globs) for
the glob subset and semantics.

You must supply exactly one of `localDir` (Node-only) or `files` (browser-friendly). Files share a content-hash dedup with Hosting's `uploadRequiredHashes`, so re-deploys that haven't changed content upload nothing.

The full pipeline is: create version → populate file manifest → upload missing files → finalize → release. The result aggregates the whole pipeline; a non-recoverable failure at any step aborts the rest.

### `DeployHostingResult`
```ts
type DeployHostingResult =
  | { success: true; data: DeployHostingSuccess }
  | { success: false; error: DeployHostingError };

interface DeployHostingSuccess {
  siteId: string;
  versionName: string;   // 'sites/{siteId}/versions/{versionId}'
  releaseName: string;   // 'sites/{siteId}/releases/{releaseId}'
  fileCount: number;     // declared in the manifest
  uploadedCount: number; // actually uploaded (≤ fileCount)
  hostingUrl: string;    // public URL once propagation completes
  channelId?: string;         // channel deploys only
  channelUrl?: string;        // server-assigned preview URL
  channelExpireTime?: string; // RFC3339 channel auto-delete time
  configWarnings?: string[];  // non-fatal config notes (unknown keys, …)
}
```
When `channelId` is set the deploy releases onto that preview channel instead of live. See [Deploy to a preview channel](../pyric-tools-deploy-how-to-deploy-to-a-preview-channel/) for the channel lifecycle.

### `DeployHostingError`
```ts
interface DeployHostingError {
  code: HostingErrorCode;
  message: string;
  recoverable: boolean;
}

type HostingErrorCode =
  | 'INVALID_INPUT'
  | 'PERMISSION_DENIED'
  | 'SITE_NOT_FOUND'
  | 'CREATE_VERSION_FAILED'
  | 'POPULATE_FAILED'
  | 'UPLOAD_FAILED'
  | 'FINALIZE_FAILED'
  | 'RELEASE_FAILED'
  | 'REWRITE_TARGET_NOT_FOUND'
  | 'CHANNEL_FAILED'
  | 'NETWORK_ERROR';
```
`REWRITE_TARGET_NOT_FOUND` is distinct from `FINALIZE_FAILED` so callers can distinguish "I deployed before the function existed" from generic finalize failures. Hosting validates rewrite targets at finalize time only.

## `hosting.sites.create(scope, input)`

Create a new Hosting site within the project.
```ts
async function create(
  scope: ProjectScope,
  input: Omit<CreateHostingSiteInput, 'projectId' | 'accessToken'>,
): Promise<CreateSiteResult>;
```
The site id must be globally unique within the project's region. Collisions return a non-recoverable error.

## `hosting.sites.ensure(scope, input)`

Idempotent variant of `create`. Returns success when the site already exists, creates it otherwise.
```ts
async function ensure(
  scope: ProjectScope,
  input: Omit<CreateHostingSiteInput, 'projectId' | 'accessToken'>,
): Promise<EnsureSiteResult>;
```
Use this when you want the deploy to work the first time and every subsequent time without conditional logic.

## `HostingJsonConfig`

The `config` option is the firebase.json hosting block, unmodified:
```ts
interface HostingJsonConfig {
  rewrites?: HostingRewriteJson[];   // destination | function (string or object) | run
  redirects?: HostingRedirectJson[]; // { source|glob|regex, destination, type? }
  headers?: HostingHeaderJson[];     // { source|glob|regex, headers: [{key,value}] }
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  appAssociation?: 'AUTO' | 'NONE';
  i18n?: { root: string };
}
```
Each rewrite names exactly one pattern (`source`/`glob`, a Hosting
glob, or `regex`) and one target: a static `destination`, a
`function` (legacy string or `{ functionId, region? }` object), or a
Cloud Run `run: { serviceId, region? }`. `dynamicLinks` is rejected
(product sunset) and `pinTag` is deferred, both with clear errors.
Invalid config fails the deploy as `INVALID_INPUT` **before** anything
is created or uploaded; non-serving keys come back as
`configWarnings`.

For the full supported/deferred/rejected table and the exact REST
translation, see [firebase.json hosting config](../pyric-tools-deploy-reference-hosting-config/).
