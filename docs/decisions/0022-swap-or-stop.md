# 0022: Swap or stop: the module swap is the guarantee, and the network guard only guards credentials

Status: Accepted

Date: 2026-10-28

David approved the direction on 2026-10-28, and later that day accepted the
recommendation for each of the seven decisions this record raised. The
answers are in [Rulings](#rulings). This record states the design, checks it
against the SDK and auth library sources, and plans the work. Refs
[#1475](https://github.com/davideast/pyric/issues/1475).

It replaces the escalation that [#1474](https://github.com/davideast/pyric/pull/1474)
added and supersedes the draft [#1488](https://github.com/davideast/pyric/pull/1488).
Only #1488's package-name check carries over.

## Context

Pyric keeps an app off production in two layers.

1. **The module swap.** Each plane replaces `firebase` and `firebase-admin`
   imports with pyric's own modules: the register's resolve hooks in Node,
   `withPyric`'s aliases and `serverExternalPackages` in Next, the Vite
   plugin's client swap and SSR routing, and the import map that `pyric sandbox`
   serves.
2. **The network guard** (`packages/cli/src/register/net-guard.ts`). It
   compares each outbound connection with a catalog of Google and Firebase
   hosts (`packages/cli/src/google-endpoints.ts`). By default it reports the
   connection and lets it through (`warn`). The Next and Vite dev servers
   default to `block`.

[#1443](https://github.com/davideast/pyric/issues/1443) showed what happens when
the swap misses. Next 16's Turbopack renamed `firebase-admin` to
`firebase-admin-<hash>`. The register didn't recognize the name, so the real
`firebase-admin` loaded, asked the GCE metadata server for credentials, and the
guard only warned. [#1471](https://github.com/davideast/pyric/pull/1471) fixed the
mapping. [#1474](https://github.com/davideast/pyric/pull/1474) added a tripwire:
the first real `firebase-admin` file escalates the guard from `warn` to `block`.

The review of #1474 ([#1475](https://github.com/davideast/pyric/issues/1475))
found that `block` still let a real `firebase-admin` reach eight Google APIs
that are not in the catalog, among them `oauth2.googleapis.com` and
`firebaserules.googleapis.com`. With a service account, `getSecurityRules()`
could overwrite production rules. #1488 widened `block` to every Google host
after the tripwire. That needed an exemption for Google Fonts on the same day,
refused the developer's own Cloud Run services, and left children with the
narrower list ([#1499](https://github.com/davideast/pyric/issues/1499)).

A host list can't settle this:

- **A short list misses APIs.** Google adds APIs faster than a catalog follows
  them. #1475 found eight missing.
- **A long list refuses what pyric needs to allow.** Live mode
  (`docs/research/live-mode.md`, [#1414](https://github.com/davideast/pyric/pull/1414))
  runs the real client SDK against `firestore.googleapis.com`,
  `identitytoolkit.googleapis.com` and the other data hosts on purpose. Ordinary
  apps load Google Fonts and call their own Cloud Run services.

Two observations point to a different design. First, every load of the real
SDK passes through one of the swap's seams, and those seams can name the
package that loaded. Second, server code can't act with admin authority until
it has a Google access token. The client SDK never asks for one: it uses the
project's API key and the signed-in user's ID token, so production's rules
decide what it can do (see Evidence).

## Decision

### 1. Swap or stop

The module swap is the primary guarantee. Wherever pyric intends a swap, a
load of the real `firebase` or `firebase-admin` package stops at load time.
The real package's code never runs.

**Detection.** The resolved file's nearest named `package.json` is checked
(`packageNameOf`, `packages/cli/src/register/package-identity.ts`, from #1471).
It catches renamed folders, npm aliases (`"admin": "npm:firebase-admin@13"`),
links under another name, and absolute-path imports. The folder name proves
nothing, so it isn't checked: #1474's `ADMIN_SEGMENT` path test
(`register/index.ts:154`) goes. #1488 measured the cost of the manifest check:
about 11 µs for a resolve the first time a directory is seen, and about 3 µs
once it's cached. To keep that cost low, the check runs only for files under a
`node_modules` directory. Every real `firebase` and `firebase-admin` install
lives under one, including pnpm and bun stores.

**What pyric intends.** One table decides, the same table every plane already
reads (`packages/cli/src/serve/firebase-module-swap.ts` and
`packages/cli/src/register/mapping.ts`):

| Package | Real load allowed when | Otherwise |
| --- | --- | --- |
| `firebase-admin` | Never, in any mode. Live mode refuses Admin per call with pyric's own module, so it stays swapped there too | Stop |
| `firebase` | The table chose the real SDK: `firebase/ai` in production AI mode (`mapping.ts:102`); `firebase/app` and `firebase/app-check` imported by pyric's own shadow modules (`isBypassedBridgeImport`, `mapping.ts:96`); a file of the `firebase` package imported from inside that package; later, the rows a live mode adds | Stop |

**The stop.** The resolve hook throws before the file loads. The error names
the specifier, the importer, the file it resolved to, and the fix:

```
@pyric/cli/register: stopped loading the real firebase-admin
  import 'firebase-admin-a14c8a5423a75469/app'
  from   file:///app/.next/dev/server/chunks/[turbopack]_runtime.js
  found  file:///app/node_modules/firebase-admin/lib/app/index.js
Under pyric, firebase-admin resolves to the sandbox. This import didn't, so it
would have run with this machine's Google credentials.
Fix: import it by package name ('firebase-admin/app'), or report the import
pyric missed: https://github.com/davideast/pyric/issues/new
code: PYRIC_REAL_SDK_STOPPED
```

The stop doesn't depend on the network guard. It replaces #1474's tripwire,
which escalated the guard.

**Each plane, and what it can and can't detect:**

| Plane | What swaps | What stop detects | What stop can't detect |
| --- | --- | --- | --- |
| Sync register hook (`module.registerHooks`, Node 22.15 and later) | `resolveFirebase` (`register/index.ts:136`), including Turbopack's renamed imports (#1471) | Every `import`, `import()` and `require` the process resolves, including absolute paths, aliases and links | A copy bundled into another file; source run through `vm` or `eval`; a worker started without the register (`worker-guard.ts` covers the known ways, #1445); child processes that aren't Node; a Node process started by a shell command that sets its own `NODE_OPTIONS`. Every child process the register's process starts gets the register in its `NODE_OPTIONS` and the parent's `PYRIC_*` variables it lacks (`child-process-guard.ts`, #1618) |
| Async fallback hook (`module.register`, older Node) | ESM `import` only (`register/hooks.ts:46`) | ESM imports. A throw in this hook rejects the import on the main thread, so unlike the tripwire it doesn't need to reach the guard. This is new coverage | CommonJS `require`, which this hook never sees. `@pyric/cli` requires `node >=22.15` (`packages/cli/package.json`), so this plane only serves Node versions pyric doesn't support |
| Next server (`withPyric`) | `serverExternalPackages` keeps both packages external, so Node resolves them through the register | The same as the sync hook. The Next dev server always runs under the register, because `enforceSandboxGuard` requires `PYRIC_SANDBOX` and the register's activation mark (`register/activation.ts`, #1625) | A dependency that ships a pre-bundled copy; edge runtime code, which Next bundles and Node never resolves |
| Vite SSR and the dev server process | The SSR alias routes the served subpaths and `firebase-admin/*` (`serve/vite-ssr-routing.ts`). Environments Vite doesn't run in this process already get a module that throws | New: the unrouted fallback (`serve/vite-module-swap.ts:177`) stops instead of resolving the real SDK. Native Node loads in the dev process, such as an externalized package that imports `firebase` itself, are caught by a sync stop hook that the plugin installs | Under plain `vite dev`, the Vite config's own static imports, which resolve before the plugin module runs. Under `pyric sandbox -- vite dev`, the register covers them |
| Browser bundles | Vite's client `resolveId` and optimizer; Next's `resolveAlias` (`next/client-aliases.ts`); the `pyric sandbox` import map, with `cli/inlined-sdk-scanner.ts` refusing a build that inlined the SDK | Vite: an unserved `firebase/*` subpath resolves to a module that throws on import (new; today `vite-module-swap.ts:140` returns the real SDK). Import map: an unmapped bare specifier already fails to resolve in the browser | Next: `resolveAlias` lists 14 specifiers, so an unlisted subpath bundles the real SDK. Whether Turbopack and webpack accept a pattern alias is checked in PR 3. Imports from a CDN (`gstatic.com/firebasejs`) aren't caught either |

A browser has no server credential to protect. A client SDK in the browser
that escapes the swap reaches production with the API key, and production's
rules apply. That is the same authority the deployed app has. Stop in the
browser is about honesty: a page that says "sandbox" shouldn't be reading
production.

### 2. The network guard becomes a credential choke point

The guard stops comparing connections with a catalog of Firebase services. It
refuses only the places a server-side Google access token comes from. Every
other host passes without a report: Firebase data hosts, Google Fonts,
`*.run.app`, `identitytoolkit` and `securetoken`.

The choke point is on in every process the register activates, and in the
Vite plugin's dev server process. Its seams are the ones #1445 hardened, and
they stay: the undici dispatcher, `net` and `tls` connect, the Agent and Socket
prototypes, the TLS `servername`, the `CONNECT` target and absolute-form proxy
paths, and worker threads.

**The refused token sources**, checked against google-auth-library 10.9.0 and
9.15.1, gtoken 7.1.0, gcp-metadata 8.1.2 and 6.1.1, and firebase-admin 13.10.0
as installed in this repo:

| Destination | What asks for a token there | Source |
| --- | --- | --- |
| `oauth2.googleapis.com` (whole host) | Service-account JWT exchange; refresh of an `authorized_user` credential, which is what gcloud ADC writes; tokeninfo and revoke | google-auth-library 10.9.0 `build/src/gtoken/getToken.js:19`, `build/src/auth/oauth2client.js:87-90`; pyric's own `packages/cli/src/credentials/node/from-adc.ts:17` |
| `www.googleapis.com`, paths `/oauth2/*/token` | gtoken 7.1.0's exchange. google-auth-library 9.15.1 uses it, and `@google-cloud/firestore` 7.11.6 (through google-gax 4.6.1) and `@google-cloud/storage` 7.21.0 load that version, so firebase-admin 13.10.0's Firestore and Storage do too | gtoken 7.1.0 `build/src/index.js:33`; probe below |
| `sts.googleapis.com`, and `sts.<universe>` | Workload identity federation, downscoped tokens, external-account authorized users | google-auth-library 10.9.0 `auth/baseexternalclient.js:55`, `auth/downscopedclient.js:110`, `auth/externalAccountAuthorizedUserClient.js:26` |
| `iamcredentials.googleapis.com`, and `iamcredentials.<universe>` | Impersonation (`generateAccessToken`); `signBlob`, which firebase-admin uses to sign custom tokens without a private key | google-auth-library 10.9.0 `auth/impersonated.js:92`, `auth/googleauth.js:883`, `auth/baseexternalclient.js:118`; firebase-admin 13.10.0 `lib/utils/crypto-signer.js:97` |
| The metadata server at `169.254.169.254`, in every form `normalizeHostname` accepts (`2852039166`, `0xa9fea9fe`, `169.254.43518`, `::ffff:169.254.169.254`, and the others from #1445) | Compute credentials | gcp-metadata 8.1.2 `build/src/index.js:69` (6.1.1: `:47`) |
| `metadata.google.internal` (with or without the trailing dot) | Secondary metadata host | gcp-metadata 8.1.2 `build/src/index.js:70` |
| `metadata` | The short name a GCE resolver completes | Not in the library sources. Refused because a caller can name it (#1488's probe) |
| `fd20:ce::254`, in every form the URL parser compresses to it | The IPv6 metadata server | Not in gcp-metadata 8.1.2. Compute Engine documents it, and a caller can name it |
| The hosts in `GCE_METADATA_HOST` and `GCE_METADATA_IP` | They replace the metadata address when set | gcp-metadata 8.1.2 `build/src/index.js:95-96` |
| The hosts that the credentials file in `GOOGLE_APPLICATION_CREDENTIALS` names in `token_url`, `service_account_impersonation_url` or `token_uri`, and `sts.` and `iamcredentials.` under its `universe_domain` | A credentials file can redirect the exchange | google-auth-library 10.9.0 `auth/baseexternalclient.js:113-118`, `auth/gdchclient.js:97`, `auth/authclient.js:66` |

The guard reads the environment and the credentials file once, when it
installs.

Some destinations are deliberately left off the list:

- **`accounts.google.com`.** google-auth-library builds a consent URL there
  for a browser (`oauth2client.js:88`) and never posts to it from a server.
  gtoken 7.1.0 only revokes there (`index.js:34`).
- **`www.googleapis.com/oauth2/v1/certs` and `/v3/certs`.** These serve
  public keys, not tokens.
- **AWS addresses** (`fd00:ec2::254`, `sts.<region>.amazonaws.com`,
  `awsclient.js:33-41`). They give AWS credentials, which become a Google
  token only at `sts.googleapis.com`, and that host is refused.

### 3. What the swap can't see, and what the choke point does there

| Case | Example | Result |
| --- | --- | --- |
| A copy of `firebase-admin` bundled into the app's server code | An esbuild server bundle that inlines `firebase-admin` | It needs a token, and the token request is refused, so its calls fail. The exception is a service-account key: see the residuals below |
| Other Google client libraries | `@google-cloud/storage`, `@google-cloud/pubsub`, `googleapis` | They load, as they do today, and their token request is refused. The same exception applies |
| Raw REST calls | `fetch('https://firestore.googleapis.com/v1/...?key=<apiKey>')` from a route handler | It reaches production with the API key, and production's rules apply. A raw call that sends a token the code already holds also gets through |

**Residuals.** The choke point doesn't cover these, so the record names them:

- **A service-account key signs its own tokens** (see Evidence). Google's
  generated clients, `@google-cloud/firestore` among them, sign a JWT locally
  from the key and send it straight to the API. They never call a token
  endpoint. This reaches production only when the real client runs, which the
  stop prevents for `firebase-admin` itself, and when a key is present. That
  leaves a bundled `firebase-admin`, or a direct `@google-cloud/firestore`,
  given a service-account key. Decision 5 closes most of this path.
- **A token the process already holds.** That could be a bearer token in a
  `.env` file, or one that `gcloud auth print-access-token` prints in a child
  process. A child that isn't Node never loads the register.
- **A client SDK that escapes the swap** in the browser or the server. It acts
  with the API key and production's rules apply: the deployed app's authority,
  not admin authority.

### 4. Live mode keeps working, and can't open either layer

- Live mode adds rows to the swap table that pick the real client SDK. Those
  rows make the real `firebase` load allowed, so stop doesn't fire.
- Live mode never turns off stop for `firebase-admin`, and never turns off the
  choke point. This carries over the rule David set on #1475: live mode "may
  only allow the client SDK's own project hosts". Under this design those
  hosts are never refused, so live mode needs no allowance at all.
- The rules-viewer credential the live-mode research gives pyric gets its
  token in the `pyric` launcher process. That process never installs the
  guard. A guarded process gets no exemption.

## Evidence

### The Firebase client SDK never calls a token endpoint

`firebase` 12.13.0 is the version in this repo's lockfile
(`@pyric/cli` devDependency `^12.12.0`). A search of `firebase@12.13.0` and
every `@firebase/*` package it uses (auth 1.13.1, firestore 4.14.1, storage
0.14.3, database 1.1.3, ai 2.12.0, app-check 0.11.3, installations 0.6.22,
functions 0.13.4, messaging 0.12.26, remote-config 0.8.3), across their node
and browser builds, finds no `oauth2.googleapis`, `sts.googleapis`,
`iamcredentials`, `169.254.169.254`, `metadata.google.internal`, `fd20:ce`,
`googleapis.com/oauth2` or `accounts.google.com`. `@firebase/firestore` has no
dependency on google-auth-library: its dependencies are `@grpc/grpc-js`,
`@grpc/proto-loader`, the webchannel wrapper and Firebase's own utilities.

What each service sends instead:

| Service | Host | Credential it sends | Source |
| --- | --- | --- | --- |
| Auth | `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` | The API key as `key=`. A token refresh posts the user's refresh token to `securetoken`'s `/v1/token` with `key=<apiKey>` | `@firebase/auth` 1.13.1 `dist/node-esm/totp-97daafa8.js:7284-7285` (hosts), `:1561-1568` (`requestStsToken`), `:881-896` (`_performApiRequest` adds `key`) |
| Firestore | `firestore.googleapis.com` | The user's ID token from the Auth SDK, and the App Check token | `@firebase/firestore` 4.14.1 `dist/common-b12d6a5a.node.mjs:29990` (`DEFAULT_HOST`), `:505` (`FirebaseAuthCredentialsProvider`), `:696` (`FirebaseAppCheckTokenProvider`) |
| Storage | `firebasestorage.googleapis.com` | `Authorization: Firebase <ID token>` and `X-Firebase-AppCheck` | `@firebase/storage` 0.14.3 `dist/node-esm/index.node.esm.js:27`, `:803-805`, `:819` |
| Realtime Database | The `databaseURL` host (`*.firebaseio.com`, `*.firebasedatabase.app`) | The token the Auth SDK provides | `@firebase/database` 1.1.3 `dist/node-esm/index.node.esm.js:1354-1371` |
| AI Logic | `firebasevertexai.googleapis.com` | `x-goog-api-key`, App Check, `Authorization: Firebase <ID token>` | `@firebase/ai` 2.12.0 `dist/index.node.mjs:27`, `:1315`, `:1322`, `:1331` |
| App Check | `content-firebaseappcheck.googleapis.com` | The API key as `key=` | `@firebase/app-check` 0.11.3 `dist/esm/index.esm.js:65`, `:372-390` |

So live mode, which runs this SDK, never meets the choke point. Production AI
mode, which already runs the real `firebase/ai`, doesn't either.

### Service-account keys sign their own tokens

`@google-cloud/firestore` 7.11.6 sets `this.auth.useJWTAccessWithScope = true`
and `this.auth.defaultServicePath` (`build/src/v1/firestore_client.js:131-133`).
google-auth-library copies both onto the JWT client: "GAPIC client libraries
should always use self-signed JWTs" (`googleauth.js:109-116` in 9.15.1). With
both set, `JWT.getRequestMetadataAsync` signs the token locally
(`jwtclient.js:55-57` in 9.15.1, the same in 10.9.0). firebase-admin 13.10.0
passes a `cert()` key straight to Firestore (`lib/firestore/firestore-internal.js:92-94`)
and to Storage (`lib/storage/storage.js:72-74`).

A probe with every network seam trapped (Node 24.16; a freshly generated RSA
key; nothing left the machine):

```
GAL9.15.1  gapic client: bearer minted = true ; network attempts = 0
GAL9.15.1  getAccessToken: exchange attempted -> host www.googleapis.com
GAL10.9.0  gapic client: bearer minted = true ; network attempts = 0
GAL10.9.0  getAccessToken: exchange attempted -> hostname oauth2.googleapis.com
```

The first and third lines are the residual. The second line is why
`www.googleapis.com/oauth2/*/token` is on the list: google-auth-library 9
exchanges there, not at `oauth2.googleapis.com`.

## What happens to the existing pieces

| Piece | Outcome |
| --- | --- |
| #1471, Turbopack renamed imports (`canonicalFirebaseSpecifier`, `package-identity.ts`) | Kept. Stop is built on `packageNameOf` |
| #1474, the tripwire (`withRealAdminTripwire`, `register/index.ts:174`) | Escalate becomes stop. `NetGuard.escalate` (`net-guard.ts:645`) and `ADMIN_SEGMENT` are removed |
| #1474, the Next dev default (`blockByDefaultInDevServer`, `next/with-pyric.ts:38`) | Removed. The choke point is the default everywhere, so `withPyric` no longer touches `PYRIC_GUARD` |
| The Vite dev default (`viteGuardEnv`, `serve/vite-net-guard.ts:56`) | The plugin still installs the guard in its process, and it is now the choke point. The `block` default and the SSR note about refused hosts go |
| #1475, item 1 (unlisted APIs) | Replaced by the choke point. Closed by PR 2 |
| #1475, item 2 (the tripwire misses aliases) | Carried into stop: the manifest name alone decides |
| #1475, item 3 (children don't inherit the escalation) | Moot. Every registered child installs its own stop and choke point, and every Node child of a registered process is registered (#1618) |
| #1475, item 4 (no Next `PYRIC_GUARD=warn` case) | Becomes a scenario case: `warn` doesn't open a token endpoint and doesn't stop a stop |
| #1475, item 5 (the docs claim the tripwire works everywhere) | Replaced: the docs describe stop per plane, including ESM on the async hook |
| #1488, every Google host after the tripwire, the Fonts exemption, escalation scope | Superseded. Only its manifest-name check carries over. David decides when to close it |
| #1499, children inherit the narrower list | Mostly moot: the choke point is the same in every registered process. What's left is the child that isn't Node, which is listed as a residual. Close it with PR 2 |
| #1442 and #1445, address forms, tunnels, workers | Kept. The choke point depends on them |
| `GOOGLE_ENDPOINT_CATALOG` | Kept for `inlined-sdk-scanner.ts`, which greps built output for SDK fingerprints. The guard stops reading it, and the metadata entries move to the token list |
| `PYRIC_GUARD_ALLOW`, the launcher's AI upstream allowance (`serve/ai-proxy.ts:196`), `permitGuardHost` | Nothing they permit is refused any more. Retired in PR 5 (decision 3) |

### `PYRIC_GUARD`

| Value | Before | After |
| --- | --- | --- |
| unset, empty, unrecognized | `warn` in registered children: report catalog hosts and let them through. `block` in the Next and Vite dev servers | The choke point refuses token sources. Nothing else is reported |
| `warn` | Report and let through, except after the tripwire | The same as unset, with one notice line saying `warn` no longer lets token requests through (decision 1) |
| `block` | Refuse catalog hosts, and the metadata server even if allowed | The same as unset |
| `off` | No guard and no tripwire | No choke point. Stop still applies (decision 4) |

## Behavior changes and migration

These ship in the next planned milestone release, with a "Behavior changes"
section in its notes. Per #1443, there's no patch release.

1. **A registered process can't get a server-side Google token.** That covers
   every Node command under `pyric sandbox -- <cmd>`, Node host remote clients,
   and the Next and Vite dev servers. Before, the default `warn` let token
   requests through. A script that uses gcloud ADC on purpose under
   `pyric sandbox` (a BigQuery export, a Firebase CLI login refresh) now gets
   `PYRIC_GUARD_BLOCKED`. Migration: run that command outside
   `pyric sandbox`, or set `PYRIC_GUARD=off` for it.
2. **A real `firebase-admin` load fails the import.** Before this change, it
   escalated the guard (#1474) or, before #1474, ran. Migration: import it by
   package name. If the import is one pyric should map, report it.
3. **A real `firebase` load where a swap is intended fails the import.** That
   covers an unserved subpath, `@firebase/*` imported by app code (decision 7),
   and a package that imports `firebase` itself in a Vite dev process.
   Production AI mode is unchanged. Migration: import a served subpath, or
   move the code out of the sandboxed process.
4. **Firebase data hosts are no longer refused or reported.** `PYRIC_GUARD=block`
   no longer refuses `firestore.googleapis.com` and the rest of the catalog,
   and neither do the Next and Vite dev servers. A raw `fetch` with an API key
   from a route handler now reaches production, with production's rules
   applied. The stderr lines `net-guard WARN <host> ... LIVE production egress`
   go away.
5. **`PYRIC_GUARD=warn` no longer lets a token request through**
   (decision 1).
6. **`PYRIC_GUARD_ALLOW` is accepted and ignored**, with one notice line
   (decision 3).
7. **On Node versions older than 22.15**, ESM imports of the real SDK now stop.

Docs to update: `packages/site-docs/src/content/reference/cli.md`
("Environment variables"), `get-started/nextjs.md` and `get-started/vite.md`.
Each PR below changes the paragraph its behavior touches.

## Decisions for David

Each is answered in [Rulings](#rulings).

1. **Does `warn` still exist for the choke point?** Options: `warn` reports a
   token request and lets it through, as today; or the choke point always
   refuses while the guard is on. **Recommended: always refuse.** A token
   request in a registered process is never a sandbox path, and warn-and-pass
   is how #1443 reached production. `warn` stays accepted as a value, with a
   notice line.
2. **Is a stop an exception or a process exit?** **Recommended: an
   exception.** The resolve hook throws `PYRIC_REAL_SDK_STOPPED`, and the
   import that asked fails. The real package never runs. Next shows the error
   in its overlay, and the dev server stays up for the other routes. A process
   exit would take down a whole dev server because of one route, and app code
   that catches a dynamic import's error still never gets the real package.
3. **Can `PYRIC_GUARD_ALLOW` open a token endpoint?** **Recommended: no, and
   retire `PYRIC_GUARD_ALLOW`.** The metadata server can't be allowed today.
   Extending that rule to every token source leaves `ALLOW` nothing to permit.
   A process that needs real Google credentials runs outside the sandbox, or
   with `PYRIC_GUARD=off`.
4. **Does `PYRIC_GUARD=off` also turn off stop?** **Recommended: no.** Stop is
   part of the swap, not the guard. A registered process that loads the real
   `firebase-admin` is wrong in every mode. To run the real SDK, run the
   process without the register (no `PYRIC_SANDBOX`).
5. **How should pyric close the service-account key path?** Options:
   - Document it as a residual.
   - In registered processes, remove `GOOGLE_APPLICATION_CREDENTIALS` when it
     names a `service_account` key, and stop loads of `@google-cloud/firestore`
     as well. `functions-rtdb/child.ts:177` already removes that variable from
     Functions children (#1427).
   - Refuse `firestore.googleapis.com` outside live mode, which brings back a
     host list.

   **Recommended: the second option.** An inline `cert()` in a bundled copy
   would remain a documented residual.
6. **For `www.googleapis.com`, refuse token paths or the whole host?**
   **Recommended: paths.** `/oauth2/*/token` is refused at the two seams that
   see a path: the undici dispatcher (`opts.path`) and `http.ClientRequest`.
   gaxios uses one or the other. Many unrelated Google APIs live on that host.
7. **Does stop cover `@firebase/*` imported directly by app code?**
   **Recommended: yes**, on the Node and Vite planes. The rule: a `@firebase/*`
   file imported from outside the `firebase` and `@firebase/*` packages and
   pyric's own modules stops. Without that rule, `import '@firebase/firestore'`
   is a side door around the swap.

## Rulings

David accepted each recommendation above on 2026-10-28
([#1510](https://github.com/davideast/pyric/pull/1510)).

1. `warn` doesn't exist for the choke point. Token requests are always refused
   while the guard is on. `warn` stays an accepted value and prints one notice
   line.
2. A stop is an exception: the resolve hook throws `PYRIC_REAL_SDK_STOPPED`,
   and only the import that asked fails. The process keeps running.
3. `PYRIC_GUARD_ALLOW` can't open a token endpoint, and is retired (PR 5).
4. `PYRIC_GUARD=off` doesn't turn off stop. To run the real SDK, run the
   process without the register.
5. In registered processes, `GOOGLE_APPLICATION_CREDENTIALS` is removed when it
   names a `service_account` key, and loads of `@google-cloud/firestore` stop
   (PR 4). An inline `cert()` in a bundled copy stays a documented residual.
6. On `www.googleapis.com`, only token paths (`/oauth2/*/token`) are refused,
   at the undici dispatcher and `http.ClientRequest`.
7. Stop covers `@firebase/*` imported directly by app code, on the Node and
   Vite planes.

## Consequences

- **One rule per layer instead of a list per service.** Stop depends on
  package names, which Firebase controls and rarely changes. The choke point
  depends on token sources, which change with the auth library. The
  implementation pins both in tests against the installed libraries.
- **Live mode and production AI mode need nothing from the guard.**
- **The safety argument now rests on the swap.** A gap in the swap is a stop
  or a residual listed here, not something the guard quietly catches. Each new
  plane needs a stop and a scenario.
- **The residuals are real.** A bundled client SDK, a key that signs its own
  tokens, and tokens a process already holds all get past. Decision 5 narrows
  the second, and the other two are documented.

## Alternatives considered

- **Add the missing hosts to the catalog** (#1475, option 1). This was
  rejected because the list always lags Google, and every host on it is one
  live mode may need.
- **Refuse every Google host after the tripwire** (#1488). This was rejected
  because it refuses Fonts and Cloud Run and conflicts with live mode. It also
  still lets the real package run until the first refusal.
- **Escalate and keep running** (#1474). This was rejected because the real
  package runs, and the outcome depends on the guard's list.
- **Exit the process on a real load.** This was rejected (decision 2).
- **Alias `firebase-admin` in `withPyric`'s Turbopack config** (#1443,
  considered then). This was rejected because it fixes Next only. The register
  is the one seam every server process goes through.

## Implementation plan

Five PRs, in order. Each touches five or fewer source and doc files. Tests and
scenarios are listed separately. Each PR writes failing tests first, runs its
app scenario against main first, and records that failure in the commit body
(AGENTS.md item 7). Locally, each PR runs only its targeted tests and its one
named scenario. CI runs the full suites and every scenario. Each PR records
the scenario's added wall time against the PR CI baseline in `PRIORITIES.md`.
No conformance rows change.

### PR 1: Stop real Firebase loads in the register

- **Files:** new `packages/cli/src/register/swap-or-stop.ts` (pure: given the
  specifier, the importer, the resolved URL and the AI mode, return "allowed"
  or the stop error); `register/index.ts` (replace the tripwire with stop);
  `register/hooks.ts` (stop on the async hook); `register/mapping.ts` (export
  the passthrough predicate so stop and the swap share it);
  `packages/site-docs/src/content/reference/cli.md`.
- **Tests:** new `packages/cli/test/register/swap-or-stop.test.ts`. A new
  `real-sdk-stop.test.ts` replaces `real-admin-tripwire.test.ts`, and the PR
  body carries a `Removes tests:` line. `register-child.test.ts` runs child
  processes covering:
  - an npm alias;
  - a renamed link with and without `--preserve-symlinks`;
  - an absolute-path `require`;
  - production AI `firebase/ai` still loading;
  - a shadow module's `firebase/app` still loading.

  The async hook is tested by calling its exported `resolve` directly. CI's
  Node satisfies `>=22.15`, so no CI process runs that hook, and the PR says
  so.
- **Scenario:** extend `test/apps/nextjs-firebase-imports.ts`, which
  `nextjs16-firebase-imports` and `nextjs15-firebase-imports` share. The route
  that loads the real `firebase-admin` by absolute path now fails with
  `PYRIC_REAL_SDK_STOPPED`. The dev log carries the stop lines, and the
  preload trap records no connection. On main, this route answers
  `PYRIC_GUARD_BLOCKED` from the escalation, so the step fails. Run
  `bun test/apps/run.ts nextjs16-firebase-imports` locally, and
  `ai-production-passthrough` in CI to show that allowed loads still run.

### PR 2: Shrink the guard to the credential choke point

- **Files:** new `packages/cli/src/google-token-endpoints.ts` (the table in
  decision 2, the `www.googleapis.com` path rule, and the hosts read from
  `GCE_METADATA_*` and the credentials file); `register/net-guard.ts`
  (evaluate against the token list; modes per the `PYRIC_GUARD` table; remove
  `escalate`); `google-endpoints.ts` (catalog kept for the scanner; the
  metadata entries move); `serve/vite-net-guard.ts`; `next/with-pyric.ts`
  (remove the dev escalation).
- **Tests:** new `packages/cli/test/google-token-endpoints.test.ts`. It
  includes a test that reads the installed google-auth-library, gtoken and
  gcp-metadata sources and fails if they name a token URL whose host isn't on
  the list. That catches the next library release. Also `net-guard.test.ts`,
  `net-guard-hosts.test.ts` (every metadata spelling refused under the
  default), `test/unit/next/with-pyric.test.ts` and
  `test/serve/vite-net-guard.test.ts`.
- **Scenario:** a new `test/apps/token-choke-point/` runs
  `pyric sandbox -- node probe.mjs` with a preload trap that sends every
  connection that isn't loopback to a closed local port. `HOME` and
  `CLOUDSDK_CONFIG` point at empty folders, and a fake `authorized_user` file
  is the only credential. The probe uses google-auth-library 10.9.0:
  - `getAccessToken()` fails with `PYRIC_GUARD_BLOCKED`;
  - `gcp-metadata`'s `isAvailable()` fails with `PYRIC_GUARD_BLOCKED`;
  - a fetch to `fonts.googleapis.com` reaches the trap without being refused;
  - in production AI mode, the real `firebase/ai` reaches the trap as
    `firebasevertexai.googleapis.com` without being refused.

  On main, the default `warn` lets the `oauth2.googleapis.com` exchange reach
  the trap, so the scenario fails. Also update `net-guard-block-address-forms`
  so its probes are refused without `PYRIC_GUARD=block`. Drop the
  Firestore-refused expectation in `nextjs-firebase-imports.ts`, and add the
  `PYRIC_GUARD=warn` case from #1475 item 4. Closes #1475 and #1499.

### PR 3: Stop in the Vite dev process and in browser bundles

- **Files:** `serve/vite-module-swap.ts` (an unserved `firebase/*` subpath,
  and the unrouted SSR fallback, resolve to a module that throws the stop
  error); `serve/vite-ssr-routing.ts`; new `serve/vite-process-stop.ts`
  (installs the sync stop hook in the dev process when no register is
  present); `serve/vite-plugin.ts`;
  `packages/site-docs/src/content/get-started/vite.md`.
- **Check first:** whether Turbopack's `resolveAlias` and webpack's
  `resolve.alias` accept a `firebase/*` pattern. If they do, a sixth file,
  `next/client-aliases.ts`, sends unlisted subpaths to the stop module. If not,
  the Next row in the table above stays a documented gap.
- **Tests:** `test/serve/vite-module-swap.test.ts` and a new
  `test/serve/vite-process-stop.test.ts`.
- **Scenario:** extend `test/apps/vite-ssr-client-sdk/` with two cases. In the
  first, a server module imports an externalized local package that imports
  `firebase-admin/app`; the SSR request fails with the stop error and the trap
  records nothing. In the second, a page imports `firebase/installations`, and
  Chromium reports the stop error. Both fail on main, where the real SDK
  loads.

### PR 4: Close the service-account key path

- **Files:** new `register/credential-scrub.ts` (read the file that
  `GOOGLE_APPLICATION_CREDENTIALS` names; when its `type` is
  `service_account`, remove the variable from `process.env` and write one line
  naming the file); `register/index.ts`; `register/swap-or-stop.ts` (add
  `@google-cloud/firestore`); `reference/cli.md`.
- **Tests:** `test/register/credential-scrub.test.ts` and
  `swap-or-stop.test.ts`.
- **Scenario:** extend `test/apps/token-choke-point/` with a generated key
  that's never registered anywhere, pointed to by
  `GOOGLE_APPLICATION_CREDENTIALS`:
  - a direct `@google-cloud/firestore` import stops;
  - a GAPIC-style google-auth-library client with that key falls back to the
    metadata server, which is refused.

  On main, the self-signed JWT goes out and the trap records
  `firestore.googleapis.com:443`.

### PR 5: Retire `PYRIC_GUARD_ALLOW` and the AI upstream allowance

- **Files:** `register/net-guard.ts` (parse and ignore with a notice; remove
  `permit` and `permitGuardHost`); `cli/sandbox-runner.ts` (`childGuardAllow`);
  `serve/ai-proxy.ts` (`aiUpstreamGuardAllowance`, `permitAiUpstreams`);
  `serve/vite-plugin.ts`; `reference/cli.md`.
- **Tests:** `test/register/net-guard.test.ts`,
  `packages/cli/src/cli/cli.test.ts` (child env), and the AI proxy unit tests.
- **Scenario:** `ai-production-passthrough` and `ai-production-app-check` pass
  unchanged. That shows the Vertex and AI Logic upstreams need no allowance.
  This PR has no new runtime path: it removes plumbing that has nothing left to
  permit.
