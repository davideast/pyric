# How to deploy Hosting rewrites that route to Cloud Functions

This guide shows you how to deploy static files to Firebase Hosting with rewrites that send specific URL paths to a deployed Cloud Function.

## Order of operations

Hosting validates rewrite targets at finalize time, not at version-creation time. If you deploy a rewrite naming a function that doesn't exist yet, the deploy fails with `REWRITE_TARGET_NOT_FOUND`.

The reliable sequence is:

1. Deploy the function (`functions.deployLocal` or `functions.deploy`).
2. Deploy Hosting with rewrites that point at it.

## Deploy a site with rewrites

```ts
import { hosting } from 'pyric-tools/deploy';

const result = await hosting.deployFiles(scope, {
  siteId: 'my-site',
  localDir: './public',
  config: {
    rewrites: [
      {
        source: '/api/**',
        function: { functionId: 'api', region: 'us-central1' },
      },
    ],
  },
});

if (result.success) {
  console.log(`Deployed: ${result.data.hostingUrl}`);
} else {
  console.error(`[${result.error.code}] ${result.error.message}`);
}
```

`config` is the firebase.json hosting block — rewrites shown here; redirects, headers, `cleanUrls`, `trailingSlash`, `appAssociation`, and `i18n` ride along the same way (see [firebase.json hosting config](../reference/hosting-config.md)). `localDir` walks the directory and uploads everything not matched by the `ignore` globs (defaults: `firebase.json`, `**/.*`, `**/node_modules/**`). Server-side dedup via content hashes means re-deploys that haven't changed content upload nothing — `data.uploadedCount` will be less than `data.fileCount`.

## From a browser host

Browsers can't walk the filesystem. Pass `files` instead, pre-walked:

```ts
import { hosting, type WalkedFile } from 'pyric-tools/deploy';

const files: WalkedFile[] = [
  { path: '/index.html', bytes: htmlBytes },
  { path: '/app.js',     bytes: jsBytes },
];

const result = await hosting.deployFiles(scope, {
  siteId: 'my-site',
  files,
  config: { rewrites: [{ source: '/api/**', function: { functionId: 'api' } }] },
});
```

`bytes` is a `Uint8Array` — read from a `File`, fetch, or any other browser source. `path` is the public URL path (leading `/`).

## Ensure the site exists first

For greenfield projects:

```ts
await hosting.sites.ensure(scope, { siteId: 'my-site' });
await hosting.deployFiles(scope, { siteId: 'my-site', /* ... */ });
```

`ensure` is idempotent — it returns success whether the site already exists or had to be created.

## Handle rewrite-target failures

The two related error codes:

| Code | Meaning |
|---|---|
| `SITE_NOT_FOUND` | The named site doesn't exist. Call `hosting.sites.ensure` first. |
| `REWRITE_TARGET_NOT_FOUND` | Finalize rejected a rewrite pointing at a function that isn't deployed. Deploy the function first, then retry. |

Both are `recoverable: true`. The deploy fails atomically — no partial release is created.

## Glob patterns

Hosting glob syntax:

- `/api` — exact match on the path `/api`.
- `/api/**` — matches `/api`, `/api/x`, `/api/x/y`, etc.
- `/foo/*` — single-segment wildcard.

For function targets, the `**` recursive form is the most common — you typically want every path under `/api` to route through the function and let the function decide what to do.

## Where to look next

- For all Hosting error codes, see [Error codes by operation — Hosting](../reference/error-codes.md#hosting).
- For deploying the function before the rewrite, see [Bundle and deploy a Cloud Function](./bundle-and-deploy-a-function.md).
- For the config shape, see [`hosting` namespace — `HostingJsonConfig`](../reference/hosting-namespace.md#hostingjsonconfig) and the full [supported-config table](../reference/hosting-config.md).
