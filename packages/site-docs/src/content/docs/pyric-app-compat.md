---
title: "pyric/app compatibility matrix"
navLabel: "App"
group: "Conformance"
section: ""
order: 8002
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/app` compatibility matrix

> **Public surface:** runtime 90% (9/10) · types 66.7% (4/6)
>
> **Fidelity:** 85.2% (23 of 27 tracked claims match production)
>
> Coverage is about whether the export exists. Fidelity is about whether each claimed interaction matches production Firebase — see the [scoreboard](../pyric-conformance-scores/) for what that percentage does and does not mean.

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

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — the mirror matches prod, locked by a passing replay</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match prod but doesn't; failing probe pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not implemented (deliberately or deferred)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — claim from docs not yet observed prod-side</span>
</div>

---

## `initializeApp(config, name?)` — the app registry

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Registers the default app under the name <code>'[DEFAULT]'</code>; <code>getApps()</code> has length 1 and <code>getApp()</code> (no arg) resolves the same instance</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Registers a named app alongside the default; <code>getApp('secondary')</code> resolves it and <code>getApps()</code> has length 2 (default + named)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A same-name re-initialization with a DIFFERENT config throws <code>FirebaseError</code> code <code>app/duplicate-app</code>, with the app name embedded in the message</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, and <code>getApps()</code> stays length 1</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-config</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getApp()</code> with no name resolves the default app instance; its name is <code>'[DEFAULT]'</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getApp('secondary')</code> resolves the named app instance; its name is <code>'secondary'</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getApp(name)</code> for a name that was never initialized throws <code>FirebaseError</code> code <code>app/no-app</code>, directing the caller to <code>initializeApp()</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-unknown-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>getApps()</code> returns an array containing every registered app by identity (the exact instances, not copies)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapps-contents</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>deleteApp(app)</code> returns a Promise, deregisters the app (so <code>getApps()</code> shrinks), a later <code>getApp(name)</code> throws <code>app/no-app</code>, and the name can be re-initialized afterwards</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>deleteApp</code> on an already-deleted app throws <code>FirebaseError</code> code <code>app/app-deleted</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp-double</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>SDK_VERSION</code> is the Firebase client SDK semver string whose behavior pyric currently mirrors, pinned to the oracle version (<code>12.13.0</code>)</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-sdk-version</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>FirebaseError</code> is an app-owned Error subclass: <code>instanceof Error</code>, <code>constructor.name</code> is <code>'FirebaseError'</code>, and it preserves <code>.code</code> and <code>.message</code> without loading <code>firebase/app</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-firebaseerror-shape</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>onLog(cb)</code> / <code>setLogLevel(level)</code> are a functioning app-owned diagnostic-logger seam: registering a handler returns undefined, raising the threshold takes effect, and a malformed <code>registerVersion</code> emits a <code>warn</code> entry (type <code>@firebase/app</code>) to the handler</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-onlog-setloglevel</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>registerVersion(library, version)</code> accepts a well-formed registration and returns undefined without throwing; malformed values emit the observed warning through the app-owned logger</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-registerversion</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><span class="compat-behavior">Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">deferred — see census deny-list (tier <code>deferred</code>) for the surface-coverage debt entry</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior"><code>initializeApp</code> snapshots options, accepts a settings object, initializes <code>automaticDataCollectionEnabled</code>, and leaves that app property mutable</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-settings-options</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Equal-config named apps are distinct app containers with equal option values and independent name-keyed registry identity</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named-equal-config</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Equal-config named apps own distinct app-associated service handles while resolving the same configured RTDB and Storage backend locators</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-multi-app-service-containers</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named-different-config</code> (firebase 12.13.0) + replay pins <code>app/multiple-configs-not-supported</code>; <code>packages/cli/test/e2e/app-multi-app.pw.ts</code> proves the same lock is enforced by the authoritative SharedWorker across same-origin tabs, not only by one page registry</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><span class="compat-behavior">Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-delete-reinitialize-different-config</code> (firebase 12.13.0) + replay pins <code>app/multiple-configs-not-supported</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Without Hosting-provided defaults, omitting options throws FirebaseError code <code>app/no-options</code> with the production message</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-no-options</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">With a registered default app, each no-argument service factory resolves a service associated with that exact default app</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-default-service-factories</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Equal-config app instances connect to one logical backend: data written through one app is readable through another, while their active Auth sessions remain independent</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-production-multi-app-topology</code> (firebase 12.13.0, real Chromium against production) + twin replay: <code>production-multi-app-oracle.test.ts</code>; served SharedWorker replay: <code>app-multi-app.pw.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After deletion resolves, every public FirebaseApp property accessor throws <code>FirebaseError</code> code <code>app/app-deleted</code></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleted-property-access</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">After deletion, fresh Auth/Firestore/RTDB/Storage factories reject; cached factories return retained handles; retained Auth sign-out resolves but a new anonymous sign-in rejects <code>app/app-deleted</code>; Firestore reads report termination, RTDB refuses new refs, Storage refs remain constructible, and <code>getAI(deletedApp)</code> returns an app-associated handle</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracles: <code>app-registry-deleted-service-factories</code> and real-Chromium <code>app-production-multi-app-topology</code> (firebase 12.13.0) + replays: <code>oracle-conformance.test.ts</code>, <code>deleted-service-lifecycle.test.ts</code>, and <code>production-multi-app-oracle.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><span class="compat-behavior">Deleting one app terminates its Firestore listener through the error callback with code <code>aborted</code>, silently stops its RTDB listener, and leaves equal-config sibling listeners and the shared backend usable</span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-production-multi-app-topology</code> (firebase 12.13.0, real Chromium against production) + twin replay: <code>production-multi-app-oracle.test.ts</code>; focused family tests: <code>multi-app-listener-auth.test.ts</code> and served <code>app-multi-app.pw.ts</code></div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><span class="compat-behavior">Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port</span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>packages/cli/test/e2e/app-deletion.pw.ts</code> observes AI code <code>unsupported</code> for a custom engine, then exercises retained and sibling models through canonical served imports after deleting one app; <code>packages/pyric/src/ai/sandbox-plane.ts</code> guards every model operation. A credentialed production AI lifecycle capture is still needed</div></div>
</details>
</div>
