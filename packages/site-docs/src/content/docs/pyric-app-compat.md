---
title: "pyric/app compatibility matrix"
navLabel: "App"
group: "Conformance"
section: ""
order: 6004
---
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
[Read how the axes differ.](../pyric-conformance-scores/)

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
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(config)</code><span class="compat-sub"><span class="compat-behavior">Registers the default app under the name <code>'[DEFAULT]'</code>; <code>getApps()</code> has length 1 and <code>getApp()</code> (no arg) resolves the same instance</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(config, 'secondary')</code><span class="compat-sub"><span class="compat-behavior">Registers a named app alongside the default; <code>getApp('secondary')</code> resolves it and <code>getApps()</code> has length 2 (default + named)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(config)</code><span class="compat-sub"><span class="compat-behavior">A same-name re-initialization with a DIFFERENT config throws <code>FirebaseError</code> code <code>app/duplicate-app</code>, with the app name embedded in the message</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(config)</code><span class="compat-sub"><span class="compat-behavior">A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, and <code>getApps()</code> stays length 1</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-config</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getApp()</code><span class="compat-sub"><span class="compat-behavior"><code>getApp()</code> with no name resolves the default app instance; its name is <code>'[DEFAULT]'</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getApp('secondary')</code><span class="compat-sub"><span class="compat-behavior"><code>getApp('secondary')</code> resolves the named app instance; its name is <code>'secondary'</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getApp(name)</code><span class="compat-sub"><span class="compat-behavior"><code>getApp(name)</code> for a name that was never initialized throws <code>FirebaseError</code> code <code>app/no-app</code>, directing the caller to <code>initializeApp()</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-unknown-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getApps()</code><span class="compat-sub"><span class="compat-behavior"><code>getApps()</code> returns an array containing every registered app by identity (the exact instances, not copies)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapps-contents</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteApp(app)</code><span class="compat-sub"><span class="compat-behavior"><code>deleteApp(app)</code> returns a Promise, deregisters the app (so <code>getApps()</code> shrinks), a later <code>getApp(name)</code> throws <code>app/no-app</code>, and the name can be re-initialized afterwards</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteApp(app)</code><span class="compat-sub"><span class="compat-behavior"><code>deleteApp</code> on an already-deleted app throws <code>FirebaseError</code> code <code>app/app-deleted</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp-double</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">SDK_VERSION</code><span class="compat-sub"><span class="compat-behavior"><code>SDK_VERSION</code> is the Firebase client SDK semver string whose behavior pyric currently mirrors, pinned to the oracle version (<code>12.13.0</code>)</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-sdk-version</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">FirebaseError</code><span class="compat-sub"><span class="compat-behavior"><code>FirebaseError</code> is an app-owned Error subclass: <code>instanceof Error</code>, <code>constructor.name</code> is <code>'FirebaseError'</code>, and it preserves <code>.code</code> and <code>.message</code> without loading <code>firebase/app</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-firebaseerror-shape</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">onLog / setLogLevel</code><span class="compat-sub"><span class="compat-behavior"><code>onLog(cb)</code> / <code>setLogLevel(level)</code> are a functioning app-owned diagnostic-logger seam: registering a handler returns undefined, raising the threshold takes effect, and a malformed <code>registerVersion</code> emits a <code>warn</code> entry (type <code>@firebase/app</code>) to the handler</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-onlog-setloglevel</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">registerVersion</code><span class="compat-sub"><span class="compat-behavior"><code>registerVersion(library, version)</code> accepts a well-formed registration and returns undefined without throwing; malformed values emit the observed warning through the app-owned logger</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-registerversion</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-main"><code class="compat-api">initializeServerApp</code><span class="compat-sub"><span class="compat-behavior">Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">deferred — see census deny-list (tier <code>deferred</code>) for the surface-coverage debt entry</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(options, settings)</code><span class="compat-sub"><span class="compat-behavior"><code>initializeApp</code> snapshots options, accepts a settings object, initializes <code>automaticDataCollectionEnabled</code>, and leaves that app property mutable</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-settings-options</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(equalOptions, 'secondary')</code><span class="compat-sub"><span class="compat-behavior">Equal-config named apps are distinct app containers with equal option values and independent name-keyed registry identity</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named-equal-config</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getAuth/getFirestore/getDatabase/getStorage(app)</code><span class="compat-sub"><span class="compat-behavior">Equal-config named apps own distinct app-associated service handles while resolving the same configured RTDB and Storage backend locators</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-multi-app-service-containers</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><code class="compat-api">initializeApp(differentOptions, 'secondary')</code><span class="compat-sub"><span class="compat-behavior">Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named-different-config</code> (firebase 12.13.0) + replay pins <code>app/multiple-configs-not-supported</code>; <code>packages/cli/test/e2e/app-multi-app.pw.ts</code> proves the same lock is enforced by the authoritative SharedWorker across same-origin tabs, not only by one page registry</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-main"><code class="compat-api">deleteApp(app); initializeApp(differentOptions)</code><span class="compat-sub"><span class="compat-behavior">Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-delete-reinitialize-different-config</code> (firebase 12.13.0) + replay pins <code>app/multiple-configs-not-supported</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp()</code><span class="compat-sub"><span class="compat-behavior">Without Hosting-provided defaults, omitting options throws FirebaseError code <code>app/no-options</code> with the production message</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-no-options</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">getAuth/getFirestore/getDatabase/getStorage()</code><span class="compat-sub"><span class="compat-behavior">With a registered default app, each no-argument service factory resolves a service associated with that exact default app</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-default-service-factories</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">initializeApp(equalOptions, name)</code><span class="compat-sub"><span class="compat-behavior">Equal-config app instances connect to one logical backend: data written through one app is readable through another, while their active Auth sessions remain independent</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-production-multi-app-topology</code> (firebase 12.13.0, real Chromium against production) + twin replay: <code>production-multi-app-oracle.test.ts</code>; served SharedWorker replay: <code>app-multi-app.pw.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteApp(app); app.name / app.options / app.automaticDataCollectionEnabled</code><span class="compat-sub"><span class="compat-behavior">After deletion resolves, every public FirebaseApp property accessor throws <code>FirebaseError</code> code <code>app/app-deleted</code></span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleted-property-access</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteApp(app); getAuth/getFirestore/getDatabase/getStorage/getAI(app)</code><span class="compat-sub"><span class="compat-behavior">After deletion, fresh Auth/Firestore/RTDB/Storage factories reject; cached factories return retained handles; retained Auth sign-out resolves but a new anonymous sign-in rejects <code>app/app-deleted</code>; Firestore reads report termination, RTDB refuses new refs, Storage refs remain constructible, and <code>getAI(deletedApp)</code> returns an app-associated handle</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracles: <code>app-registry-deleted-service-factories</code> and real-Chromium <code>app-production-multi-app-topology</code> (firebase 12.13.0) + replays: <code>oracle-conformance.test.ts</code>, <code>deleted-service-lifecycle.test.ts</code>, and <code>production-multi-app-oracle.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-main"><code class="compat-api">deleteApp(app)</code><span class="compat-sub"><span class="compat-behavior">Deleting one app terminates its Firestore listener through the error callback with code <code>aborted</code>, silently stops its RTDB listener, and leaves equal-config sibling listeners and the shared backend usable</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-production-multi-app-topology</code> (firebase 12.13.0, real Chromium against production) + twin replay: <code>production-multi-app-oracle.test.ts</code>; focused family tests: <code>multi-app-listener-auth.test.ts</code> and served <code>app-multi-app.pw.ts</code></div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-main"><code class="compat-api">getAI(app, customEngine); deleteApp(app); retainedModel operation</code><span class="compat-sub"><span class="compat-behavior">Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port</span></span></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>packages/cli/test/e2e/app-deletion.pw.ts</code> observes AI code <code>unsupported</code> for a custom engine, then exercises retained and sibling models through canonical served imports after deleting one app; <code>packages/pyric/src/ai/sandbox-plane.ts</code> guards every model operation. A credentialed production AI lifecycle capture is still needed</div></div>
</details>
</div>

## Current gaps

### Documented divergences

Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">initializeApp(differentOptions, 'secondary')</code><span class="compat-sub">Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend</span></span></div>
</div>
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">deleteApp(app); initializeApp(differentOptions)</code><span class="compat-sub">Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization</span></span></div>
</div>
</div>

### Unsupported

Tracked behavior that is not implemented in the current contract.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">initializeServerApp</code><span class="compat-sub">Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet</span></span></div>
</div>
</div>

### Unverified

Tracked behavior whose available evidence does not yet establish the production result.

<div class="compat-list compat-list--plain">
<div class="compat-row">
<div class="compat-line"><span class="compat-main"><code class="compat-api">getAI(app, customEngine); deleteApp(app); retainedModel operation</code><span class="compat-sub">Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port</span></span></div>
</div>
</div>
