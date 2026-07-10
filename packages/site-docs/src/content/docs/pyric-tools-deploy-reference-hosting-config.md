---
title: "firebase.json hosting config: supported keys and REST translation"
navLabel: "firebase.json hosting config"
group: "pyric-tools / deploy"
section: "Reference"
order: 64
---
# firebase.json hosting config: supported keys and REST translation

The hosting block of `firebase.json` is the public config shape
(`HostingJsonConfig`). It is translated to the Hosting REST
`ServingConfig` exactly the way firebase-tools' `convertConfig` does
(`clones/firebase-tools/src/deploy/hosting/convertConfig.ts`. Every
translation below is pinned by a test in
`test/deploy/hosting/config.test.ts` citing the relevant lines.)

The contract: every key is **supported**, **deferred with a clear
error**, or **rejected with the reason**. Unknown keys produce a loud
warning. Nothing is ever silently dropped.

## Supported

| firebase.json key | REST translation | Notes |
|---|---|---|
| `public` | — (CLI: walked directory → `localDir`) | Per-entry static root. |
| `site` / `target` | — (CLI: site selection) | `target` resolves through `.firebaserc` `targets.<project>.hosting.<target>` → one or more sites. |
| `ignore` | — (applied while walking) | See [ignore globs](#ignore-globs) below. |
| `rewrites[].source` / `glob` | `glob` | Interchangeable spellings; `glob` wins when both present. |
| `rewrites[].regex` | `regex` | RE2. Exactly one of glob/regex per entry (both or neither → error). |
| `rewrites[].destination` | `path` | Static rewrite. |
| `rewrites[].function` (legacy string `+ region`) | scalar `function` + `functionRegion` | Normalized exactly like upstream (`hosting/config.ts:262-289`). |
| `rewrites[].function: { functionId, region? }` | scalar `function` + `functionRegion` | See [divergences](#documented-divergences) on backend validation. |
| `rewrites[].run: { serviceId, region? }` | `run: { serviceId, region }` | `region` defaults to `us-central1` client-side (convertConfig.ts:252). |
| `redirects[]` | `{ glob\|regex, location, statusCode? }` | `destination` → `location`; `type` → `statusCode`, omitted when absent (Hosting serves **301** by default). |
| `headers[]` | `{ glob\|regex, headers: { k: v } }` | The `[{ key, value }]` array becomes the REST **map**. |
| `cleanUrls` | `cleanUrls` | Pass-through boolean. |
| `trailingSlash` | `trailingSlashBehavior: 'ADD' \| 'REMOVE'` | `true` → ADD, `false` → REMOVE. |
| `appAssociation` | `appAssociation` | `'AUTO' \| 'NONE'` only. |
| `i18n: { root }` | `i18n: { root }` | Pass-through. |

## Deferred (rejected with a clear error until built)

| Key | Why | Where it's tracked |
|---|---|---|
| `rewrites[].function.pinTag` / `run.pinTag` | Pinning a channel to a function/Run revision needs Cloud Run traffic tagging. | the design rationale Track C. |

## Rejected (with the reason in the error)

| Key | Reason |
|---|---|
| `rewrites[].dynamicLinks` | Firebase Dynamic Links was sunset (August 2025). The rewrite can never serve. |

## Warned (consumed elsewhere or unsupported, but never silent)

| Key | Warning points to |
|---|---|
| `public`, `site`, `target`, `ignore` *inside a tool `config` input* | The `localDir`/`files`, `siteId`, and `ignore` tool inputs (the CLI consumes these keys itself). |
| `predeploy` / `postdeploy` | Hooks are not run by `pyric deploy`. |
| `source` / `frameworksBackend` | Web-frameworks integration is not supported. |
| anything else | "unknown hosting config key" warning naming the key. |

Warnings surface on stderr before the CLI deploys and ride on the
success payload as `configWarnings` for programmatic callers.

## Ignore globs

Walking `localDir` applies, in order:

1. Always: `**/firebase-debug.log`, `**/firebase-debug.*.log`,
   `.firebase/*` (hard-coded in firebase-tools' walker,
   `src/listFiles.ts:8`).
2. The `ignore` list. When absent, the firebase-tools scaffold
   defaults apply: `["firebase.json", "**/.*", "**/node_modules/**"]`
   (`src/init/features/hosting/index.ts:20`). An explicit list (even
   `[]`) replaces the defaults, exactly like editing the key.

Supported glob subset: `**` (whole segments), `*`, `?`, `{a,b}`
(nesting ok). Character classes (`[abc]`) and extglobs are **not**
supported and match literally. Patterns are dot-mode (a `*` matches
dotfiles) and match the POSIX-relative path.

Parity quirk, preserved deliberately: `**/.*` excludes dotFILES at any
depth but **not files inside dot-directories**: `.git/config` uploads,
exactly as it does with firebase-tools (glob@10 ignore semantics;
only `/**`-suffixed patterns skip a whole subtree).

## Documented divergences

- **No client-side backend validation.** Upstream lists the project's
  Cloud Functions to validate function rewrites and converts CFv2
  functions to Run rewrites (convertConfig.ts:84-130). Pyric forwards
  `function` + `functionRegion` as-is (upstream's "endpoint not found,
  still including it" branch) and relies on Hosting's finalize-time
  validation. A missing target fails the deploy with
  `REWRITE_TARGET_NOT_FOUND`.
- **Defaults applied when `ignore` is absent.** A hand-written
  firebase.json with no `ignore` key gets the scaffold defaults rather
  than uploading dotfiles (upstream applies no defaults at deploy time;
  they exist because `firebase init` writes them into the file).
- **Channel TTL applies on creation only**: re-deploying to an
  existing channel does not extend it (upstream `--expires` PATCHes the
  TTL; see the preview-channel how-to).
