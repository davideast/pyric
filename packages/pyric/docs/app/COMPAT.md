<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/app` compatibility matrix

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Public surface:</strong> runtime 90% (9/10) <span aria-hidden="true">·</span> types 66.7% (4/6)</p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">85.2%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">23 of 27 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 23 conform, 2 documented divergences, 0 bugs, 1 unsupported, 1 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 23" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 2" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unsupported" style="flex-grow: 1" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="unverified" style="flex-grow: 1" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>23</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>2</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>1</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>1</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">Public surface measures whether exports exist. Fidelity measures whether tracked behavior matches production.</p>
</div>
[Read how the axes differ.](../conformance/SCORES.md)

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

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| initializeApp(config) |  | Registers the default app under the name `'[DEFAULT]'`; `getApps()` has length 1 and `getApp()` (no arg) resolves the same instance | ✓ | oracle: `app-registry-initializeapp-default` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 1 |
| initializeApp(config, 'secondary') |  | Registers a named app alongside the default; `getApp('secondary')` resolves it and `getApps()` has length 2 (default + named) | ✓ | oracle: `app-registry-initializeapp-named` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 2 |
| initializeApp(config) |  | A same-name re-initialization with a DIFFERENT config throws `FirebaseError` code `app/duplicate-app`, with the app name embedded in the message | ✓ | oracle: `app-registry-initializeapp-duplicate-name` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 3 |
| initializeApp(config) |  | A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, and `getApps()` stays length 1 | ✓ | oracle: `app-registry-initializeapp-duplicate-config` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 4 |
| getApp() |  | `getApp()` with no name resolves the default app instance; its name is `'[DEFAULT]'` | ✓ | oracle: `app-registry-getapp-default` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 5 |
| getApp('secondary') |  | `getApp('secondary')` resolves the named app instance; its name is `'secondary'` | ✓ | oracle: `app-registry-getapp-named` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 6 |
| getApp(name) |  | `getApp(name)` for a name that was never initialized throws `FirebaseError` code `app/no-app`, directing the caller to `initializeApp()` | ✓ | oracle: `app-registry-getapp-unknown-name` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 7 |
| getApps() |  | `getApps()` returns an array containing every registered app by identity (the exact instances, not copies) | ✓ | oracle: `app-registry-getapps-contents` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 8 |
| deleteApp(app) |  | `deleteApp(app)` returns a Promise, deregisters the app (so `getApps()` shrinks), a later `getApp(name)` throws `app/no-app`, and the name can be re-initialized afterwards | ✓ | oracle: `app-registry-deleteapp` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 9 |
| deleteApp(app) |  | `deleteApp` on an already-deleted app throws `FirebaseError` code `app/app-deleted` | ✓ | oracle: `app-registry-deleteapp-double` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 10 |
| SDK_VERSION |  | `SDK_VERSION` is the Firebase client SDK semver string whose behavior pyric currently mirrors, pinned to the oracle version (`12.13.0`) | ✓ | oracle: `app-registry-sdk-version` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 11 |
| FirebaseError |  | `FirebaseError` is an app-owned Error subclass: `instanceof Error`, `constructor.name` is `'FirebaseError'`, and it preserves `.code` and `.message` without loading `firebase/app` | ✓ | oracle: `app-registry-firebaseerror-shape` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 12 |
| onLog / setLogLevel |  | `onLog(cb)` / `setLogLevel(level)` are a functioning app-owned diagnostic-logger seam: registering a handler returns undefined, raising the threshold takes effect, and a malformed `registerVersion` emits a `warn` entry (type `@firebase/app`) to the handler | ✓ | oracle: `app-registry-onlog-setloglevel` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 13 |
| registerVersion |  | `registerVersion(library, version)` accepts a well-formed registration and returns undefined without throwing; malformed values emit the observed warning through the app-owned logger | ✓ | oracle: `app-registry-registerversion` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 14 |
| initializeServerApp |  | Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet | — | deferred — see census deny-list (tier `deferred`) for the surface-coverage debt entry | 15 |
| initializeApp(options, settings) |  | `initializeApp` snapshots options, accepts a settings object, initializes `automaticDataCollectionEnabled`, and leaves that app property mutable | ✓ | oracle: `app-registry-initializeapp-settings-options` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 16 |
| initializeApp(equalOptions, 'secondary') |  | Equal-config named apps are distinct app containers with equal option values and independent name-keyed registry identity | ✓ | oracle: `app-registry-initializeapp-named-equal-config` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 17 |
| getAuth/getFirestore/getDatabase/getStorage(app) |  | Equal-config named apps own distinct app-associated service handles while resolving the same configured RTDB and Storage backend locators | ✓ | oracle: `app-registry-multi-app-service-containers` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 18 |
| initializeApp(differentOptions, 'secondary') |  | Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend | ⚠ | oracle: `app-registry-initializeapp-named-different-config` (firebase 12.13.0) + replay pins `app/multiple-configs-not-supported`; `packages/cli/test/e2e/app-multi-app.pw.ts` proves the same lock is enforced by the authoritative SharedWorker across same-origin tabs, not only by one page registry | 19 |
| deleteApp(app); initializeApp(differentOptions) |  | Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization | ⚠ | oracle: `app-registry-delete-reinitialize-different-config` (firebase 12.13.0) + replay pins `app/multiple-configs-not-supported` | 20 |
| initializeApp() |  | Without Hosting-provided defaults, omitting options throws FirebaseError code `app/no-options` with the production message | ✓ | oracle: `app-registry-initializeapp-no-options` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 21 |
| getAuth/getFirestore/getDatabase/getStorage() |  | With a registered default app, each no-argument service factory resolves a service associated with that exact default app | ✓ | oracle: `app-registry-default-service-factories` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 22 |
| initializeApp(equalOptions, name) |  | Equal-config app instances connect to one logical backend: data written through one app is readable through another, while their active Auth sessions remain independent | ✓ | oracle: `app-production-multi-app-topology` (firebase 12.13.0, real Chromium against production) + twin replay: `production-multi-app-oracle.test.ts`; served SharedWorker replay: `app-multi-app.pw.ts` | 23 |
| deleteApp(app); app.name / app.options / app.automaticDataCollectionEnabled |  | After deletion resolves, every public FirebaseApp property accessor throws `FirebaseError` code `app/app-deleted` | ✓ | oracle: `app-registry-deleted-property-access` (firebase 12.13.0) + replay: `oracle-conformance.test.ts` | 24 |
| deleteApp(app); getAuth/getFirestore/getDatabase/getStorage/getAI(app) |  | After deletion, fresh Auth/Firestore/RTDB/Storage factories reject; cached factories return retained handles; retained Auth sign-out resolves but a new anonymous sign-in rejects `app/app-deleted`; Firestore reads report termination, RTDB refuses new refs, Storage refs remain constructible, and `getAI(deletedApp)` returns an app-associated handle | ✓ | oracles: `app-registry-deleted-service-factories` and real-Chromium `app-production-multi-app-topology` (firebase 12.13.0) + replays: `oracle-conformance.test.ts`, `deleted-service-lifecycle.test.ts`, and `production-multi-app-oracle.test.ts` | 25 |
| deleteApp(app) |  | Deleting one app terminates its Firestore listener through the error callback with code `aborted`, silently stops its RTDB listener, and leaves equal-config sibling listeners and the shared backend usable | ✓ | oracle: `app-production-multi-app-topology` (firebase 12.13.0, real Chromium against production) + twin replay: `production-multi-app-oracle.test.ts`; focused family tests: `multi-app-listener-auth.test.ts` and served `app-multi-app.pw.ts` | 26 |
| getAI(app, customEngine); deleteApp(app); retainedModel operation |  | Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port | ? | `packages/cli/test/e2e/app-deletion.pw.ts` observes AI code `unsupported` for a custom engine, then exercises retained and sibling models through canonical served imports after deleting one app; `packages/pyric/src/ai/sandbox-plane.ts` guards every model operation. A credentialed production AI lifecycle capture is still needed | 27 |

## Current gaps

### Documented divergences

Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.

| API | Behavior |
|---|---|
| initializeApp(differentOptions, 'secondary') | Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend |
| deleteApp(app); initializeApp(differentOptions) | Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization |

### Unsupported

Tracked behavior that is not implemented in the current contract.

| API | Behavior |
|---|---|
| initializeServerApp | Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet |

### Unverified

Tracked behavior whose available evidence does not yet establish the production result.

| API | Behavior |
|---|---|
| getAI(app, customEngine); deleteApp(app); retainedModel operation | Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port |
