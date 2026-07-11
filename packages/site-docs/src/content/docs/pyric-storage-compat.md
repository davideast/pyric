---
title: "pyric/storage compatibility matrix"
navLabel: "Storage"
group: "Compatibility"
section: ""
order: 33
---
<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/storage` compatibility matrix

> ⚠ **EXPERIMENTAL — not v1-supported.** `pyric/storage` is functional but
> work-in-progress. The v1-supported, conformance-held surface is **auth +
> firestore + rules**. The `✓` rows below are verified **sandbox-side** by unit
> probes against the documented `firebase/storage` contract — they are NOT
> wrong — but most are **not yet captured against a live prod project** (no
> `oracle:` citation), so conformance is best-effort, not guaranteed. Don't
> depend on storage parity for a production swap yet.

The single readable contract for "what this shim guarantees vs the
production `firebase/storage` SDK."

See the design rationale for the methodology (vocabulary
of conformance / oracle / matrix; how to add rows; how the runner
attributes failures).

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — sandbox matches prod, locked by a passing probe</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match prod but doesn't; failing probe pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not implemented yet (deliberately or pending)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — claim from docs that we haven't yet observed prod-side</span>
</div>

Probe references: `unit:<file>` means a Bun test under
`packages/pyric/test/storage/<file>`. `oracle:<name>` cites an observation
under `scripts/oracle/observations/<name>.json` captured by
`scripts/oracle/run.ts` against a real Firebase project.

Targets:
- **sandbox** — IDB-backed handle built via `getStorageSandbox(target, options?)`.
  Identity is either a `SandboxContext` (frozen at handle-construction)
  or a `Sandbox` (anonymous, via `sandbox.withAuth(null)`). Rule
  evaluation runs in-process via `enforce.ts`.
- **prod** — `firebase/storage` target built via `getStorageProd(app)`.
  Identity flows naturally from `firebase/auth`'s `currentUser`; rules
  enforced server-side by Firebase.

Storage differs from auth/firestore in a few load-bearing ways the
matrix has to cover:
- Two layers of payload (the blob bytes AND the metadata record).
- Content-type negotiation with three sources (caller hint, blob's
  intrinsic type, fallback to `application/octet-stream`).
- Reference identity is a value object, not an interned handle —
  `ref(s, 'a/b')` twice are equal-by-path, not `===`.
- The persistence layer for sandbox is IDB (with `fake-indexeddb` in
  tests); prod is the Firebase Storage REST API plus a downloadURL
  surface backed by token-signed GETs.

---

## `getStorageSandbox(target, options?)` / `getStorageProd(app, options?)` — initializer

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getStorageSandbox(ctx)</code> returns a tagged sandbox-target handle (frozen identity)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getStorageSandbox(sandbox)</code> wraps a bare Sandbox with an anonymous context (<code>auth: null</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getStorageProd(app)</code> returns a tagged prod-target handle</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Two <code>getStorageSandbox(ctx)</code> calls on the same context return the SAME wrapper (identity-stable)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code> ("returns the same handle for repeated calls on the same context")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Two <code>getStorageSandbox(sandbox)</code> calls on a bare <code>Sandbox</code> return the SAME wrapper (identity-stable)</span></summary>
<div class="compat-evidence"><div class="compat-probe">ST-B3 fixed: <code>withAuth(null)</code> mints a fresh context per call, so the per-context cache missed and bare-Sandbox calls returned different handles. A <code>Sandbox</code>-keyed cache makes the convenience path stable, matching the docstring. Probe: <code>unit:service.test.ts</code> ("ST-B3: returns the same handle for repeated bare-Sandbox calls").</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Two different <code>SandboxContext</code>s on the same <code>Sandbox</code> get DIFFERENT handles but share the underlying <code>StorageService</code> (IDB)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code> ("shares the underlying StorageService across contexts on the same sandbox")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>options.bucket</code> round-trips on metadata records; v1 has a single implicit bucket but the field is preserved</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code> ("records the bucket value on the handle")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>options.dbName</code> honored on the FIRST call per <code>Sandbox</code>; second-call overrides ignored</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code> ("dbName only takes effect on the sandbox's first getStorage call")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>options.rules</code> parsed eagerly — malformed rules throw <code>SyntaxError</code> at config time</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> (parse errors propagate from <code>parseStorageRules</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Handle dispatch by <code>TARGET_SYMBOL</code> brand — ops route to their owning target</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code> ("getStorageService throws — service is sandbox-only")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Unrecognized handle (not produced by a factory) → <code>TypeError</code> "not a FirebaseStorage handle"</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code> ("throws TypeError on objects without TARGET_SYMBOL")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod handle: <code>bucket</code> field sourced from the SDK's resolved bucket (so <code>gs://</code> overrides round-trip)</span></summary>
<div class="compat-evidence"><div class="compat-probe">implicit in <code>unit:prod-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>getStorageSandbox(undefined)</code> / bare-call default-to-sandbox in playground preview</span></summary>
<div class="compat-evidence"><div class="compat-probe">not yet wired — mirror of the <code>getFirestore</code> wrap (auth #4 / firestore #4)</div></div>
</details>
</div>

## `ref(storage[, path])` / `ref(parent, path)` — reference constructor

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>ref(storage)</code> returns the root ref — <code>fullPath === ''</code>, <code>name === ''</code>, <code>parent === null</code>, <code>root === self</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("root reference has empty fullPath, null parent, and equal root")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>ref(storage, 'sessions/s1.json')</code> populates <code>fullPath</code>, <code>name</code> (last segment), <code>parent</code> (path without last segment)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("ref(storage, path) populates fullPath and name from the last segment")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Path normalization: leading slashes stripped (<code>/sessions/s1</code> → <code>sessions/s1</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("normalizes leading/trailing/double slashes")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">16</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Path normalization: trailing slashes stripped</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">17</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Path normalization: repeated internal slashes collapsed (<code>a//b</code> → <code>a/b</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">18</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>ref(parent, child)</code> joins relative to parent's <code>fullPath</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("ref(parent, child) joins relative to the parent")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">19</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>parent</code> chain walks back to root (each <code>.parent</code> strips one segment until empty, then <code>null</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("parent traversal walks back to root")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">20</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>root</code> accessor returns the bucket-root ref regardless of starting depth</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">21</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>toString()</code> returns <code>gs://&lt;bucket&gt;/&lt;fullPath&gt;</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("toString returns gs://bucket/path")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">22</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Reference identity: two <code>ref(s, 'a/b')</code> calls are equal-by-<code>toString</code> but NOT <code>===</code> (value objects, not interned)</span></summary>
<div class="compat-evidence"><div class="compat-probe">(implicit in <code>unit:reference.test.ts</code> parent-chain test — each <code>.parent</code> returns a fresh object)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">23</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod refs proxy the underlying <code>firebase/storage</code> ref via a WeakMap; <code>parent</code> / <code>root</code> recursively wrap to keep target consistent</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code> (delegation pattern documented in <code>reference.ts</code>)</div></div>
</details>
</div>

## `uploadBytes(ref, data, metadata?)` — write blob

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Accepts <code>Blob</code> payload; returns <code>UploadResult</code> with populated <code>metadata</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("accepts a Blob and round-trips through getBlob")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">25</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Accepts <code>Uint8Array</code> payload</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("accepts a Uint8Array")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">26</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Accepts <code>ArrayBuffer</code> payload</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("accepts an ArrayBuffer")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">27</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">ContentType precedence: caller's <code>metadata.contentType</code> &gt; <code>Blob.type</code> &gt; <code>application/octet-stream</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("metadata.contentType overrides the Blob's intrinsic type" + "falls back to application/octet-stream when no type is supplied")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">28</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Blob.type === ''</code> (no intrinsic type) falls through to <code>application/octet-stream</code>, NOT to <code>''</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("falls back to application/octet-stream when no type is supplied")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">29</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>customMetadata</code> round-trips through the upload pipeline</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("round-trips customMetadata") + <code>unit:metadata.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">30</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Empty <code>Blob.type</code> rewrap: when caller hint differs from <code>Blob.type</code>, the blob is re-wrapped with the caller's type (same bytes)</span></summary>
<div class="compat-evidence"><div class="compat-probe">implicit in <code>unit:reference.test.ts</code> ("metadata.contentType overrides the Blob's intrinsic type")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">31</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>storage/invalid-root-operation</code> when called on the root reference</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws on root reference")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">32</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>metadata.fullPath</code> matches the ref's <code>fullPath</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">33</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>metadata.size</code> matches the input blob's byte length</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">34</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>metadata.bucket</code> matches the storage handle's bucket</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="unverified">
<summary class="compat-line"><span class="compat-num">35</span><span class="compat-dot" data-status="unverified" role="img" aria-label="Unverified" title="Unverified"></span><span class="compat-behavior">Replaces any existing object at the path (overwrite, not append)</span></summary>
<div class="compat-evidence"><div class="compat-probe">sandbox semantics in <code>persistence.ts</code> use <code>put</code>; no explicit overwrite test</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">36</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: round-trips uploaded bytes through <code>getDownloadURL</code> + fetch (byte-for-byte equality)</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-upload-bytes-roundtrip.json</code> (against blockingfun, fb-js-sdk 12.13.0: 6-byte payload → uploadBytes → getDownloadURL → HTTPS fetch → <code>bytesMatch: true</code>, <code>urlIsHttps: true</code>, <code>bodyLen === payloadLen === 6</code>). Sandbox doesn't ship <code>getDownloadURL</code> (row #51 is <code>—</code>); the round-trip is observed prod-side only.</div>
<div class="compat-note">(prod-only)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">37</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>metadata.contentType</code> matches what the caller hinted (when set)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> + oracle: <code>scripts/oracle/observations/storage-upload-then-getmetadata.json</code> (<code>contentType: 'application/octet-stream'</code> round-trip against blockingfun, fb-js-sdk 12.13.0; <code>contentTypeMatches: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">38</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>metadata.generation</code> / <code>metageneration</code> are stringified counters (<code>'1'</code> after fresh upload)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code></div></div>
</details>
</div>

## `uploadString(ref, value, format?, metadata?)` — write string-form

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">39</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>format='raw'</code> (default): UTF-8 encodes the string; <code>contentType</code> defaults to <code>text/plain;charset=utf-8</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("raw format encodes UTF-8 and defaults contentType to text/plain")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">40</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>format='base64'</code>: decodes payload bytes from standard base64</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("base64 format decodes payload bytes")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">41</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Sandbox: <code>format='base64url'</code> (or any unknown format) rejected with <code>storage/invalid-format</code> naming the bad format. Prod: <code>base64url</code> is ACCEPTED (upload succeeds); a genuinely-unrecognized format throws <code>storage/unknown</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence, both halves oracle-locked by <code>scripts/oracle/observations/storage-uploadstring-unknown-format.json</code>: prod accepts <code>base64url</code> (<code>base64urlOk: true</code>) and throws <code>storage/unknown</code> for an unrecognized format — not <code>storage/invalid-format</code>. The v1 sandbox ships only <code>raw</code>/<code>base64</code>/<code>data_url</code> (matches <code>StringFormat</code>) and throws <code>storage/invalid-format</code> for anything else (ST-B3 replaced the old mis-parse-as-data_url behavior). Both sides pinned in <code>oracle-conformance.test.ts</code>; sandbox code path documented in <code>upload.ts</code>'s <code>decodeString</code>. Implementing base64url decoding is still one line in <code>decodeString</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">42</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>format='data_url'</code>: parses <code>data:&lt;mime&gt;;base64,&lt;payload&gt;</code>, infers <code>contentType</code> from prefix</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("data_url format infers contentType from the prefix")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">43</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>format='data_url'</code> with non-base64 payload: percent-decodes the body</span></summary>
<div class="compat-evidence"><div class="compat-probe">(covered by <code>decodeString</code> else-branch; no explicit test for the URL-encoded form yet)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">44</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Caller's <code>metadata.contentType</code> beats data_url inference</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("caller metadata.contentType beats data_url inference")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">45</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Malformed <code>data_url</code> (no comma / doesn't start with <code>data:</code>) throws <code>TypeError</code> with "data_url format" message</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws on malformed data_url")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">46</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: <code>uploadString(ref, value, 'base64')</code> round-trips via <code>getDownloadURL</code> + fetch</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-uploadstring-base64-roundtrip.json</code> (<code>'aGVsbG8='</code> → <code>'hello'</code> against blockingfun, fb-js-sdk 12.13.0; <code>textMatches: true</code>)</div>
<div class="compat-note">(prod-only)</div></div>
</details>
</div>

## `uploadBytesResumable(ref, data, metadata?)` — resumable upload + task observers

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">47</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Exported by <code>firebase/storage</code>; returns an <code>UploadTask</code> with <code>pause()</code> / <code>resume()</code> / <code>cancel()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented in <code>pyric/storage</code> — out of scope for the v1 v1 scope per <code>index.ts</code></div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">48</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>task.on('state_changed', next, error, complete)</code> fires <code>next</code> with <code>{bytesTransferred, totalBytes, state}</code> snapshots</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">49</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>task.pause()</code> flips <code>state</code> to <code>'paused'</code>; <code>task.resume()</code> continues</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">50</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>task.cancel()</code> rejects the upload with <code>storage/canceled</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented</div></div>
</details>
</div>

## `getDownloadURL(ref)` — read URL

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">51</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Exported by <code>firebase/storage</code>; returns a token-signed HTTPS URL that fetches the blob</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented in <code>pyric/storage</code> — out of scope per <code>index.ts</code> (no browser-renderable URL in the IDB sandbox)</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">52</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Throws <code>storage/object-not-found</code> for missing objects</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented; oracle would lock prod's error shape if we ever add it</div></div>
</details>
</div>

## `getBytes(ref, maxDownloadSize?)` — read as ArrayBuffer

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">53</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the blob's contents as an <code>ArrayBuffer</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("accepts a Uint8Array" round-trip via <code>getBytes</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">54</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>storage/object-not-found</code> when no object exists at the path</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws storage/object-not-found for missing paths") + oracle: <code>scripts/oracle/observations/storage-delete-then-get-throws.json</code> (against blockingfun, fb-js-sdk 12.13.0: upload → delete → <code>getDownloadURL</code> on the deleted ref throws <code>FirebaseError</code> with <code>code: 'storage/object-not-found'</code>)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">55</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Throws when <code>blob.size &gt; maxDownloadSize</code> with <code>.code</code> exposed</span></summary>
<div class="compat-evidence"><div class="compat-probe">code-divergence (ST-B1): sandbox now throws a <code>StorageError</code> with <code>.code === 'storage/quota-exceeded'</code> (was a plain <code>Error</code> with the code only in the message). Prod's client-side cap throws <code>FirebaseError</code> with <code>code: 'storage/invalid-argument'</code> — the codes still differ, but both now expose <code>.code</code>. Probe: <code>unit:error-codes.test.ts</code> ("quota-exceeded when the blob exceeds maxDownloadSizeBytes"). Documented in <code>download.ts</code>. Aligning the code value to <code>invalid-argument</code> is deferred pending an oracle capture of prod's exact shape.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">56</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Just-under-cap reads succeed and return the full byte length</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("honors maxDownloadSizeBytes when the blob is too large")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">57</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>storage/invalid-root-operation</code> when called on the root reference</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws invalid-root-operation on root reads")</div></div>
</details>
</div>

## `getBlob(ref, maxDownloadSize?)` — read as Blob

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">58</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns the stored bytes wrapped as a <code>Blob</code> (with <code>.type</code> from metadata)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("accepts a Blob and round-trips through getBlob")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">59</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>storage/object-not-found</code> for missing paths</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws storage/object-not-found for missing paths")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">60</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Honors <code>maxDownloadSize</code> same as <code>getBytes</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">(shared <code>fetchBlob</code> helper in <code>download.ts</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">61</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Root-ref read throws <code>storage/invalid-root-operation</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">shared via <code>guardNonRoot</code> in <code>download.ts</code></div></div>
</details>
</div>

## `getStream(ref, maxDownloadSize?)` — Node-specific

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">62</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Exported by <code>firebase/storage</code> (Node entry only); returns a Node <code>Readable</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented in <code>pyric/storage</code> — browser-shaped v1 scope, no Node-stream variant</div></div>
</details>
</div>

## `deleteObject(ref)` — delete

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">63</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Removes both the blob AND the metadata atomically (post-delete <code>getBlob</code> throws <code>object-not-found</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("removes both blob and metadata")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">64</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Sandbox: no-op on missing path (does NOT throw)</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox is no-op via <code>persistence.ts</code>'s <code>delete</code>. Prod's <code>deleteObject</code> on a missing path throws <code>storage/object-not-found</code>. Oracle-locked: <code>scripts/oracle/observations/storage-delete-missing-throws.json</code> (<code>code: 'storage/object-not-found'</code>, <code>name: 'FirebaseError'</code> against blockingfun, fb-js-sdk 12.13.0). Both sides pinned in <code>oracle-conformance.test.ts</code>; documented in <code>download.ts</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">65</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>storage/invalid-root-operation</code> on the root reference</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:reference.test.ts</code> ("throws invalid-root-operation on root")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">66</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: a successful <code>deleteObject</code> followed by <code>getDownloadURL</code> on the same ref throws <code>storage/object-not-found</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-delete-then-get-throws.json</code> (against blockingfun, fb-js-sdk 12.13.0: upload + delete succeed, then <code>getDownloadURL</code> throws <code>code: 'storage/object-not-found'</code>, message <code>"Firebase Storage: Object '…' does not exist."</code>, <code>isFirebaseError: true</code>)</div>
<div class="compat-note">(prod-only)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">67</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox: writes-then-delete leaves no metadata (post-delete <code>getMetadata</code> throws <code>object-not-found</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe">follows from #63 + <code>getMetadata</code></div></div>
</details>
</div>

## `listAll(ref)` — list all children under a ref

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">68</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>ListResult</code> with <code>items</code> (direct child files) + <code>prefixes</code> (sub-folder refs) + <code>nextPageToken: undefined</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">69</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Empty bucket → both arrays empty, <code>nextPageToken: undefined</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("returns empty arrays on an empty bucket")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">70</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Direct children only — does NOT recurse into grandchildren as items</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("does not recurse into grandchildren as items")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">71</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sub-folders surface as <code>prefixes</code> and are deduplicated (many files under one folder → ONE prefix entry)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("promotes sub-folders into prefixes (deduplicated)")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">72</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>items</code> sorted by path (IDB key order, lexicographic)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("lists direct children of a folder")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">73</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>prefixes</code> sorted lexicographically by <code>fullPath</code> (for determinism)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> (root-scan example asserts <code>configs</code> &lt; <code>sessions</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">74</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The scanned ref itself is NEVER included in <code>items</code> (even when an object exists at the exact prefix path)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("does not include the scanned ref itself")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">75</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>listAll(ref(storage))</code> (root) scans the entire bucket</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("listAll on the root scans the entire bucket")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">76</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Items expose the full <code>StorageReference</code> shape (storage, bucket, name, parent)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:list.test.ts</code> ("items expose the StorageReference shape")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">77</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: items + prefixes shape matches sandbox after <code>N</code> uploads under a directory</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-listall-shape.json</code> (against blockingfun, fb-js-sdk 12.13.0: 3 direct children + 1 grandchild → <code>items</code> has all 3 direct children sorted, <code>prefixes</code> has the single sub-folder, <code>itemCount: 3</code>, <code>prefixCount: 1</code>, <code>threeDirectChildren: true</code>, <code>oneSubPrefix: true</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">77a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>listAll</code> enforces rules: <code>read</code> permission on the scanned prefix path governs list (Firebase: <code>read</code> covers download AND list), denied prefix → <code>storage/unauthorized</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">ST-B2 fixed: <code>list.ts</code> now calls <code>enforceRules</code> with <code>method: 'read'</code> on the listed prefix (was a silent bypass — a denied tree was still fully enumerable). With no rules configured the check is a no-op. Probe: <code>unit:list-rules.test.ts</code> ("denies an anonymous listAll of a tree the rules protect" / "allows an authed listAll"). Note: a <code>read</code> rule scoped to <code>match /sessions/{id}</code> does NOT grant list on <code>/sessions</code> — the folder needs its own read rule, matching prod; the session-archive demo ruleset adds <code>match /sessions { allow read }</code>.</div></div>
</details>
</div>

## `list(ref, options?)` — paginated list

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">78</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Exported by <code>firebase/storage</code>; accepts <code>{ maxResults, pageToken }</code>, returns a <code>ListResult</code> with <code>nextPageToken</code> set when more pages remain</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented in <code>pyric/storage</code> — pagination deferred per <code>list.ts</code> (the <code>ListResult.nextPageToken</code> field is kept optional so consumer code that handles pagination doesn't have to special-case the sandbox)</div></div>
</details>
</div>

## `getMetadata(ref)` / `updateMetadata(ref, metadata)` — metadata ops

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">79</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getMetadata(ref)</code> returns the same <code>FullMetadata</code> shape <code>uploadBytes</code> produced</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("returns the FullMetadata uploadBytes wrote")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">80</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getMetadata(ref)</code> throws <code>storage/object-not-found</code> for missing paths</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("throws object-not-found for missing paths")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">81</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getMetadata(ref)</code> throws <code>storage/invalid-root-operation</code> on the root</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("throws invalid-root-operation on the root reference")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">82</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata(ref, patch)</code> replaces the listed client-settable fields wholesale (per Firebase semantics)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("replaces settable fields, bumps metageneration, refreshes updated")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">83</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> bumps <code>metageneration</code> by 1 on each call</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">84</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> refreshes <code>updated</code> to the call moment; <code>timeCreated</code> and <code>generation</code> stay pinned</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">85</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> preserves the blob bytes (only metadata changes)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("leaves the blob content untouched")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">86</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>updateMetadata</code> with <code>undefined</code> field values preserves the prior value (does NOT clear it)</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: prod accepts <code>null</code> to explicitly clear a field. Sandbox doesn't model <code>null</code>-clear (per <code>metadata.ts</code> doc comment). Documented; not probe-locked.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">87</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> throws <code>storage/object-not-found</code> for missing paths</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("throws object-not-found when the path is missing")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">88</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> throws <code>storage/invalid-root-operation</code> on the root</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:metadata.test.ts</code> ("throws invalid-root-operation on the root reference")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">89</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: <code>getMetadata</code> after <code>uploadBytes</code> returns <code>contentType</code> and <code>size</code> matching what was uploaded</span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-upload-then-getmetadata.json</code> (against blockingfun, fb-js-sdk 12.13.0: upload 128-byte payload with <code>contentType: 'application/octet-stream'</code>, getMetadata returns <code>metadataSize: 128</code>, <code>metadataContentType: 'application/octet-stream'</code>, <code>metadataBucket: 'blockingfun.firebasestorage.app'</code>, <code>metadataMetageneration: '1'</code>, <code>fullPathMatches: true</code>)</div>
<div class="compat-note">(prod-only)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">90</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Prod: <code>updateMetadata({customMetadata: {...}})</code> round-trips through a follow-up <code>getMetadata</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/storage-update-metadata-roundtrip.json</code> (against blockingfun, fb-js-sdk 12.13.0: post-update <code>getMetadata</code> returns the exact <code>customMetadata</code> object, <code>metageneration</code> bumps <code>'1'</code> → <code>'2'</code>, <code>customSurvived: true</code>, <code>metagenerationBumped: true</code>)</div>
<div class="compat-note">(prod-only)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">91</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>FullMetadata.md5Hash</code> populated on uploads</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox does NOT compute <code>md5Hash</code>. Oracle-locked: <code>scripts/oracle/observations/storage-upload-then-getmetadata.json</code> confirms prod sets <code>md5Hash</code> (<code>hasMd5Hash: true</code> after a vanilla <code>uploadBytes</code>). Both sides pinned in <code>oracle-conformance.test.ts</code>. Aligning the sandbox is a one-spot fix in <code>upload.ts</code>'s <code>buildStoredMetadata</code>.</div></div>
</details>
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">92</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior"><code>FullMetadata.ref</code> lazy population (prod populates lazily)</span></summary>
<div class="compat-evidence"><div class="compat-probe">not modeled in <code>pyric/storage</code> — <code>metadata.ts</code> explicitly omits <code>ref</code> from <code>FullMetadata</code></div></div>
</details>
</div>

## `connectStorageEmulator(storage, host, port)` — emulator hook

<div class="compat-list">
<details class="compat-row" data-status="unsupported">
<summary class="compat-line"><span class="compat-num">93</span><span class="compat-dot" data-status="unsupported" role="img" aria-label="Unsupported" title="Unsupported"></span><span class="compat-behavior">Exported by <code>firebase/storage</code>; reroutes a <code>FirebaseStorage</code> handle to a local emulator</span></summary>
<div class="compat-evidence"><div class="compat-probe">not implemented in <code>pyric/storage</code> — the sandbox IS the local-target alternative; emulator parity is out of scope per <code>index.ts</code></div></div>
</details>
</div>

## Rules — `parseStorageRules` / `evaluateStorageRules` / `getStorage(ctx, { rules })`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">94</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>parseStorageRules(source)</code> returns an opaque handle</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("parses the canonical session-archive ruleset")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">95</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>parseStorageRules</code> rejects non-<code>firebase.storage</code> service headers</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("rejects unknown service header")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">96</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>evaluateStorageRules</code> supports granular verbs (<code>get</code>/<code>list</code>/<code>create</code>/<code>update</code>/<code>delete</code>) alongside <code>read</code>/<code>write</code> umbrella expansion, comma-separated verb lists, and per-verb default-deny</span></summary>
<div class="compat-evidence"><div class="compat-probe">STALE ROW, corrected 2026-07-10: production capture proves the evaluator already supports the full six-verb grant surface (umbrella read→{get,list}, write→{create,update,delete}, single granular grants, comma-separated grants, per-verb deny-by-default), matching production verdict-for-verdict on 12 of the pack's 13 non-existence cases. <code>oracle:rules-storage-verbs-umbrella-granular</code> (all <code>read</code>/<code>write</code>/<code>get</code>/comma-verb cases). One related existence-semantics case in the same pack diverges — pinned separately as a KNOWN_DIVERGENCE (issue #134), not a granular-verb gap.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">97</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>parseStorageRules</code> rejects unterminated string literals with <code>SyntaxError</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("rejects unterminated strings")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">98</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>evaluateStorageRules</code> matches <code>match /sessions/{id} { allow read: if request.auth != null; }</code> for an authed read</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("allows authenticated reads of /sessions/{id}")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">99</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>evaluateStorageRules</code> denies anonymous reads when the rule requires <code>request.auth != null</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("denies anonymous reads")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">100</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>evaluateStorageRules</code> supports <code>request.resource.size &lt; N</code> constraints (with arithmetic literals like <code>10 <em> 1024 </em> 1024</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> ("allows JSON writes under 10MB")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">101</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>evaluateStorageRules</code> supports <code>request.resource.contentType == '&lt;mime&gt;'</code> constraints</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> (mime constraint inside the session-archive ruleset)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">102</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Multi-segment wildcard <code>{allPaths=**}</code> matches zero-or-more remaining segments</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> (parser + evaluator both honor the <code>**</code> form)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">103</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Path-parameter binding (<code>{sessionId}</code>) accessible inside the <code>if</code> expression</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">104</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">User-defined <code>function</code> definitions — <code>let</code> bindings, functions calling functions, and match-block-scoped helper functions (lexical scoping)</span></summary>
<div class="compat-evidence"><div class="compat-probe">STALE ROW, corrected 2026-07-10: production capture proves the evaluator supports user-defined functions with <code>let</code> bindings, nested function calls, and block-scoped helpers. <code>oracle:rules-storage-functions-let-scope</code> matches production verdict-for-verdict on all 5 cases. Same-name shadowing and undefined-function calls are compile-time rejections in production and are covered by evaluator unit tests instead (they cannot be captured as a clean production verdict).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">112</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>request.time</code> compared against <code>timestamp.date(y,m,d)</code> and <code>timestamp.value(ms)</code> constructors</span></summary>
<div class="compat-evidence"><div class="compat-probe">NEW ROW, 2026-07-10: production capture proves the evaluator supports <code>request.time</code> comparisons against both timestamp constructors. <code>oracle:rules-storage-request-time-timestamp</code> matches production verdict-for-verdict on all 4 cases (deadline-before/after via <code>timestamp.date()</code>, epoch-bound before/after via <code>timestamp.value()</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">113</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>string.matches(regex)</code> with whole-string anchoring (a partial match denies)</span></summary>
<div class="compat-evidence"><div class="compat-probe">NEW ROW, 2026-07-10: production capture proves <code>matches()</code> is whole-string anchored, matching a RE2 pattern only when it covers the entire string. <code>oracle:rules-storage-matches-regex</code> matches production verdict-for-verdict on all 3 cases. RE2-inexpressible patterns are rejected at ruleset compile time by production and are covered by evaluator unit tests instead.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">114</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>resource.metadata.&lt;key&gt;</code> custom-metadata access in dotted (<code>resource.metadata.owner</code>) and bracket (<code>resource.metadata['owner']</code>) form, including missing-key deny</span></summary>
<div class="compat-evidence"><div class="compat-probe">NEW ROW, 2026-07-10: production capture proves dotted and bracket metadata access resolve identically, and a missing key denies. <code>oracle:rules-storage-metadata-access</code> matches production verdict-for-verdict on all 5 cases.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">115</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Cross-service <code>firestore.get()</code> / <code>firestore.exists()</code> lookups from a Storage ruleset, with <code>$(expr)</code> path interpolation and qualified function-mock names</span></summary>
<div class="compat-evidence"><div class="compat-probe">NEW ROW, 2026-07-10: production capture proves the evaluator resolves cross-service Firestore lookups from Storage rules, including interpolated document paths and both the map-returning <code>get()</code> and bool-returning <code>exists()</code> forms. <code>oracle:rules-storage-firestore-lookup</code> matches production verdict-for-verdict on all 4 cases.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">116</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>resource.timeCreated</code> / <code>resource.updated</code> — server-populated object timestamps</span></summary>
<div class="compat-evidence"><div class="compat-probe">NEW ROW, 2026-07-10: witness capture confirms the evaluator's resource model carries only size/contentType/metadata, so <code>resource.timeCreated</code>/<code>resource.updated</code> read <code>undefined</code> and any comparison denies in-process, while production evaluates a real server timestamp. <code>oracle:rules-storage-resource-timestamp-witness</code> records production's DENY verdict on both cases; the evaluator's DENY happens to match here because both operands are non-comparable rather than because the field is modeled — the underlying field is still unsupported.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">105</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Op-level enforcement: <code>uploadBytes</code> against a denied path throws <code>storage/unauthorized</code> on sandbox / <code>storage/unauthorized</code> on prod, <code>.code</code> exposed on both</span></summary>
<div class="compat-evidence"><div class="compat-probe">ST-B1 fixed: sandbox now throws a <code>StorageError</code> (see <code>src/storage/errors.ts</code>) whose <code>.code === 'storage/unauthorized'</code> — matching prod's <code>FirebaseError.code</code>. Probe: <code>unit:error-codes.test.ts</code> ("unauthorized when rules deny the operation"). Residual divergence (documented, not a <code>.code</code> gap): the sandbox <code>StorageError.name</code> is <code>'StorageError'</code> (plain <code>Error</code> subclass, same shape as Firestore's <code>SandboxError</code>) where prod reports <code>name: 'FirebaseError'</code> / <code>isFirebaseError: true</code>, and the message wording differs (sandbox embeds the matched-rule reason chain). Oracle-locked: <code>scripts/oracle/observations/storage-rules-denied-error-code.json</code> (against blockingfun, fb-js-sdk 12.13.0: <code>code: 'storage/unauthorized'</code>, message <code>"Firebase Storage: User does not have permission to access '&lt;path&gt;'."</code>, <code>name: 'FirebaseError'</code>, <code>isFirebaseError: true</code>).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">106</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getMetadata</code> against a denied path throws <code>storage/unauthorized</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code> (operation-integration section)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">107</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateMetadata</code> against a denied path throws <code>storage/unauthorized</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">108</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>deleteObject</code> against a denied path throws <code>storage/unauthorized</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules.test.ts</code></div></div>
</details>
</div>

## `sandbox.*` (sandbox-only test driver)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">109</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getStorageService(storage)</code> returns the backing <code>StorageService</code> for sandbox handles (sandbox-only escape hatch for tests)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">110</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getStorageService</code> on a prod-target handle throws <code>Error: …sandbox-only</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code> ("throws — service is sandbox-only")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">111</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>targetOf(storage)</code> returns the discriminated <code>Target</code> (sandbox / prod)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:service.test.ts</code></div></div>
</details>
</div>

## Visible gaps / open questions

- `getDownloadURL` is the most commonly-used Storage API in real apps
  and isn't implemented. Adding it gates: download-URL token format,
  cache headers, signing, CORS preflight. Tracked under `index.ts`'s
  "out of scope" header.
- `uploadBytesResumable` (rows 47-50) — the entire upload-task + observer
  surface is unmodeled. The session-archive use case (the v1 driver)
  uses one-shot `uploadBytes`, so this stayed deferred.
- `connectStorageEmulator` — the sandbox replaces the emulator's role
  for local development, but a prod-target Storage handle in a Bun
  test still can't be re-routed to the emulator without this hook.
- `md5Hash` (row 91) — sandbox doesn't compute it. Oracle confirms
  prod always sets it. Worth a one-row alignment if real consumer
  code reads it.
- Prod target row #11 — needs an explicit oracle observation against
  `firebase/storage` to lock the bucket-name format (with vs without
  `gs://` prefix).

## Rows locked by the empirical oracle harness

Committed observations under `scripts/oracle/observations/`, captured
against the `blockingfun` project on fb-js-sdk 12.13.0:

- #36 `uploadBytes` → `getDownloadURL` → fetch round-trip — bytes
  match exactly; URL is HTTPS.
- #37 `metadata.contentType` matches caller's hint — exact round-trip.
- #46 `uploadString(_, _, 'base64')` → `getDownloadURL` → fetch text —
  decodes correctly.
- #54 / #66 `getDownloadURL` on a deleted ref — throws
  `FirebaseError` with `code: 'storage/object-not-found'`.
- #64 `deleteObject` on a never-uploaded path — throws
  `FirebaseError` with `code: 'storage/object-not-found'`. **Sandbox
  diverges** (no-op).
- #77 `listAll` shape — items + prefixes sort lex-order; 3 direct
  children + 1 sub-folder yields the documented shape.
- #89 `getMetadata` after `uploadBytes` — `contentType`, `size`,
  `fullPath`, `bucket`, `metageneration: '1'` all match.
- #90 `updateMetadata({customMetadata})` — round-trips through a
  follow-up `getMetadata`; `metageneration` bumps `'1'` → `'2'`.
- #91 `md5Hash` — prod sets it on every upload. **Sandbox diverges**
  (does not compute).
- #105 Op-level rules-denied — prod throws `FirebaseError` with
  `code: 'storage/unauthorized'`; message shape recorded.

## Divergences surfaced by oracle observations (not fixed in this PR)

- **`deleteObject` on missing path** (row #64) — sandbox is a no-op
  via `persistence.ts`'s `delete`; prod throws
  `storage/object-not-found`. Fix candidate: detect-and-throw in
  `download.ts`'s `deleteObject` sandbox path.
- **`md5Hash` not populated by sandbox** (row #91) — prod always sets
  it. Fix candidate: compute hex md5 in `upload.ts`'s
  `buildStoredMetadata` (Node `crypto` or Web Crypto in browser).
- **`uploadString` format handling** (row #41) — prod accepts
  `base64url` and throws `storage/unknown` for a genuinely-unknown
  format; the sandbox throws `storage/invalid-format` for both. Fix
  candidates: decode `base64url` in `decodeString` (one line) and
  align the unknown-format error code.
- **Sandbox `quota-exceeded` error code value** (row #55) — ST-B1
  gave the sandbox a `StorageError` class, so the cap now throws with
  `.code === 'storage/quota-exceeded'` (was a plain `Error`). The
  remaining gap is the code *value*: prod throws a `FirebaseError`
  with `code: 'storage/invalid-argument'` for the client-side cap.
  Aligning the value is deferred pending an oracle capture of prod's
  exact shape.
- **`null`-clear semantics in `updateMetadata`** (row #86) — sandbox
  preserves prior values when patch fields are `undefined`, but
  doesn't model `null`-clear at all. Documented in `metadata.ts`.

---

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/storage` but the sandbox refuses to import or
model them. They're either out-of-scope per the v1 scope or pending
a follow-up driver decision.

| Name | Reason |
|---|---|
| `getDownloadURL` | Out of scope — no browser-renderable URL in the IDB sandbox. Re-enable with a token-signed `blob:` URL or a fake CDN endpoint when needed. |
| `uploadBytesResumable` + `UploadTask` (pause/resume/cancel, state_changed observer) | Out of scope — session-archive use case is one-shot upload-bytes only |
| `getStream` | Node-stream variant not modeled in the browser-shaped v1 scope |
| `list(ref, { maxResults, pageToken })` paginated form | Deferred — `listAll` covers the v1 scope scenarios; pagination needs a stable `pageToken` shape |
| `connectStorageEmulator` | Sandbox replaces the emulator; emulator parity is out of scope |
| Cloud Functions Storage triggers (`onFinalize`, `onArchive`, …) | Server-side surface — not the Web SDK |
| Image transformation URLs (Firebase Image extension) | Extension surface, not core Storage |
| `StorageObserver` advanced shapes (progress milestones, error subclasses) | Tied to `UploadTask`; out of scope until resumable ships |
