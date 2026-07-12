---
title: "pyric/app compatibility matrix"
navLabel: "App"
group: "Compatibility"
section: ""
order: 8002
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/app` compatibility matrix

**14 of 15 tracked behaviors match production Firebase (93%).**

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span>Matches Firebase</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span>Documented difference</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span>Not supported yet</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span>Not verified yet</span>
</div>

## `initializeApp(config, name?)` — the app registry

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Registers the default app under the name <code>'[DEFAULT]'</code>; <code>getApps()</code> has length 1 and <code>getApp()</code> (no arg) resolves the same instance</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Registers a named app alongside the default; <code>getApp('secondary')</code> resolves it and <code>getApps()</code> has length 2 (default + named)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A same-name re-initialization with a DIFFERENT config throws <code>FirebaseError</code> code <code>app/duplicate-app</code>, with the app name embedded in the message</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, <code>getApps()</code> stays length 1 (reference identity is the deep-equal-options analog for a <code>{ sandbox }</code> config)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-initializeapp-duplicate-config</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getApp()</code> with no name resolves the default app instance; its name is <code>'[DEFAULT]'</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-default</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getApp('secondary')</code> resolves the named app instance; its name is <code>'secondary'</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-named</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getApp(name)</code> for a name that was never initialized throws <code>FirebaseError</code> code <code>app/no-app</code>, directing the caller to <code>initializeApp()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapp-unknown-name</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getApps()</code> returns an array containing every registered app by identity (the exact instances, not copies)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-getapps-contents</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>deleteApp(app)</code> returns a Promise, deregisters the app (so <code>getApps()</code> shrinks), a later <code>getApp(name)</code> throws <code>app/no-app</code>, and the name can be re-initialized afterwards</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>deleteApp</code> on an already-deleted app throws <code>FirebaseError</code> code <code>app/app-deleted</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-deleteapp-double</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>SDK_VERSION</code> is the firebase client SDK semver string pyric mirrors — re-exported from <code>firebase/app</code>, so it IS the version the rig captured against (currently <code>12.13.0</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-sdk-version</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>FirebaseError</code> is <code>firebase/app</code>'s own error class (re-exported): <code>instanceof Error</code>, <code>constructor.name</code> is <code>'FirebaseError'</code>, and it preserves <code>.code</code> and <code>.message</code> — so mirror throws match prod on <code>instanceof</code> and code</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-firebaseerror-shape</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>onLog(cb)</code> / <code>setLogLevel(level)</code> are the firebase diagnostic-logger seam (re-exported functioning implementations, not inert tokens): registering a handler returns undefined, raising the threshold takes effect, and a malformed <code>registerVersion</code> emits a <code>warn</code> entry (type <code>@firebase/app</code>) to the handler</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-onlog-setloglevel</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div>
<div class="compat-note">(re-export)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>registerVersion(library, version)</code> registers a platform-logger version component (re-exported functioning implementation); a well-formed call returns undefined without throwing</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>app-registry-registerversion</code> (firebase 12.13.0) + replay: <code>oracle-conformance.test.ts</code></div>
<div class="compat-note">(re-export)</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet</span></summary>
<div class="compat-evidence"><div class="compat-probe">deferred — see census deny-list (tier <code>deferred</code>) for the surface-coverage debt entry</div></div>
</details>
</div>

## Not supported yet

Tracked but not implemented yet. Each flips to ✓ as support lands.

| # | Behavior |
|---|---|
| 15 | Not implemented — server-app (SSR) initialization is deferred: a FirebaseServerApp carries per-request auth/heartbeat state with no decided sandbox mirror pattern yet |
