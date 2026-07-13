<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/app` compatibility matrix

> **Surface coverage:** 39.1% of Firebase's public exports · 90% of what pyric intends to mirror
>
> **Fidelity:** 93.3% (14 of 15 tracked claims match production)
>
> Coverage is about whether the export exists. Fidelity is about whether each claimed interaction matches production Firebase — see the [scoreboard](../conformance/SCORES.md) for what that percentage does and does not mean.

The single readable contract for "what the `pyric/app` initialization surface
guarantees vs the production `firebase/app` client SDK." `pyric/app` is the
entry point every user hits first: `initializeApp`, the name-keyed app registry
(`getApp` / `getApps` / `deleteApp`), the `FirebaseError` class and `SDK_VERSION`
constant, and the diagnostic logger seam (`onLog` / `setLogLevel` /
`registerVersion`).

The registry rows are authored from the `app-registry-*` oracle observations
(pure in-process captures of the installed `firebase/app` package — no project,
no network) and replayed verdict-for-verdict by
`packages/pyric/test/app/oracle-conformance.test.ts`.

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — the mirror matches prod, locked by a passing replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |
| — | **Unsupported** — not implemented (deliberately or deferred) |
| ? | **Unverified** — claim from docs not yet observed prod-side |

---

## `initializeApp(config, name?)` — the app registry

| # | Behavior | Status | Probe |
|---|---|---|---|
| 1 | Registers the default app under the name `'[DEFAULT]'`; `getApps()` has length 1 and `getApp()` (no arg) resolves the same instance | ✓ | oracle: `app-registry-initializeapp-default` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 2 | Registers a named app alongside the default; `getApp('secondary')` resolves it and `getApps()` has length 2 (default + named) | ✓ | oracle: `app-registry-initializeapp-named` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 3 | A same-name re-initialization with a DIFFERENT config throws `FirebaseError` code `app/duplicate-app`, with the app name embedded in the message | ✓ | oracle: `app-registry-initializeapp-duplicate-name` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 4 | A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, `getApps()` stays length 1 (reference identity is the deep-equal-options analog for a `{ sandbox }` config) | ✓ | oracle: `app-registry-initializeapp-duplicate-config` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 5 | `getApp()` with no name resolves the default app instance; its name is `'[DEFAULT]'` | ✓ | oracle: `app-registry-getapp-default` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 6 | `getApp('secondary')` resolves the named app instance; its name is `'secondary'` | ✓ | oracle: `app-registry-getapp-named` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 7 | `getApp(name)` for a name that was never initialized throws `FirebaseError` code `app/no-app`, directing the caller to `initializeApp()` | ✓ | oracle: `app-registry-getapp-unknown-name` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 8 | `getApps()` returns an array containing every registered app by identity (the exact instances, not copies) | ✓ | oracle: `app-registry-getapps-contents` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 9 | `deleteApp(app)` returns a Promise, deregisters the app (so `getApps()` shrinks), a later `getApp(name)` throws `app/no-app`, and the name can be re-initialized afterwards | ✓ | oracle: `app-registry-deleteapp` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 10 | `deleteApp` on an already-deleted app throws `FirebaseError` code `app/app-deleted` | ✓ | oracle: `app-registry-deleteapp-double` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 11 | `SDK_VERSION` is the Firebase client SDK semver string whose behavior pyric currently mirrors, pinned to the oracle version (`12.13.0`) | ✓ | oracle: `app-registry-sdk-version` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 12 | `FirebaseError` is an app-owned Error subclass: `instanceof Error`, `constructor.name` is `'FirebaseError'`, and it preserves `.code` and `.message` without loading `firebase/app` | ✓ | oracle: `app-registry-firebaseerror-shape` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 13 | `onLog(cb)` / `setLogLevel(level)` are a functioning app-owned diagnostic-logger seam: registering a handler returns undefined, raising the threshold takes effect, and a malformed `registerVersion` emits a `warn` entry (type `@firebase/app`) to the handler | ✓ | oracle: `app-registry-onlog-setloglevel` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 14 | `registerVersion(library, version)` accepts a well-formed registration and returns undefined without throwing; malformed values emit the observed warning through the app-owned logger | ✓ | oracle: `app-registry-registerversion` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` |
| 15 | Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet | — | deferred — see census deny-list (tier `deferred`) for the surface-coverage debt entry |
