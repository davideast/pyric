---
title: "pyric/rules compatibility matrix"
navLabel: "Rules"
group: "Compatibility"
section: ""
order: 8005
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/rules` compatibility matrix

Rules is a NATIVE conformance surface: there is no `firebase/rules` module to
mirror, so this contract is NOT measured against an upstream SDK. It is measured
two ways. The claimable API is the public export set of `pyric/rules` (and the
Storage rules exports on `pyric/storage`); the fidelity is the in-process rules
simulators replayed verdict-for-verdict against the production Firestore and
Storage **Rules Test API** engines. There is no export-breadth percentage here
(no upstream denominator); completeness is measured against the surface's own
public API.

The two engines share this one document because `pyric/rules` is one package
front door: its engine-agnostic exports (`lint`, `eachCase`, `assertCase`,
`explainCase`, the value helpers) cannot be partitioned across per-engine
registries. Firestore rules and Storage rules each carry their own engine table
below, partitioned by observation prefix (`rules-firestore-` / `rules-storage-`).

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong> — the simulator matches the production Rules Test API verdict, locked by a replayed observation</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong> — a known simulator divergence from production with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong> — should match production but doesn't; a failing replay pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong> — not modeled yet (deliberately or pending)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong> — a claim we haven't yet observed against the production engine</span>
</div>

Oracle references: `oracle:rules-firestore-<pack>` / `oracle:rules-storage-<pack>` cite
an observation captured by `packages/conformance/src/run-rules.ts` /
`run-rules-storage.ts` against the production Rules Test API and replayed by the
rules oracle-conformance suites. The corpus lives at
`packages/conformance/rules-corpus/{firestore,storage}/`.

---

## Firestore rules engine — production simulator conformance (rules-firestore corpus)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">160</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">CEL builtins <code>math.<em></code>/<code>timestamp.</em></code>/<code>duration.*</code> (FM3) — arithmetic, date, and duration comparisons in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-builtins-time-and-math</code> — production Firestore Rules Test API verdicts for corpus pack "builtins-time-and-math", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">161</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>Bytes</code>, <code>String.toUtf8()</code>, and <code>hashing.{md5,sha256,crc32,crc32c}()</code> (Item 5.3) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-bytes-toutf8-and-hashing</code> — production Firestore Rules Test API verdicts for corpus pack "bytes-toutf8-and-hashing", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator's toUtf8/md5/sha256/crc32/crc32c byte-encoding and reference-hash implementations diverge from production on all 5 pack cases, so a rule that should DENY on hash mismatch ALLOWs locally — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">162</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Typed cross-type operator overloads for <code>Timestamp</code>/<code>Duration</code> (Item 2) in rules — no silent numeric coercion / type-identity loss</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-cross-type-operator-overloads</code> — production Firestore Rules Test API verdicts for corpus pack "cross-type-operator-overloads", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">163</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">CEL tri-state error absorption in <code>||</code>/<code>&amp;&amp;</code> (RULES-B3) — <code>error || true</code> → ALLOW, <code>error &amp;&amp; false</code> → DENY, commutative absorption (not JS left-to-right short-circuit)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-error-absorption-and-or</code> — production Firestore Rules Test API verdicts for corpus pack "error-absorption-and-or", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">164</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>getAfter()</code>/<code>existsAfter()</code> (Item 7) in rules — post-write document identity and existence semantics</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-get-after-and-exists-after</code> — production Firestore Rules Test API verdicts for corpus pack "get-after-and-exists-after", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator does not model the post-write document identity/existence production compares against on 4 pack cases (getAfter target identity, existsAfter on create/delete, existsAfter over an unrelated mocked path) — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">165</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>get()</code> of a missing document (RULES-B8) in rules — resource identity (<code>id</code>/<code>__name__</code>) exposure on a mocked/missing get() result</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-get-missing-doc</code> — production Firestore Rules Test API verdicts for corpus pack "get-missing-doc", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator synthesizes a resource identity (<code>id</code>, <code>__name__</code>) for mocked get() results that production leaves absent, on 2 pack cases — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">166</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>request.path</code>/<code>request.query</code>/<code>resource.id</code>/<code>resource.__name__</code> globals (Item 6) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-globals-request-path-and-resource-id</code> — production Firestore Rules Test API verdicts for corpus pack "globals-request-path-and-resource-id", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator models <code>request.query</code> as an empty map on the empty-query case where production denies the equivalent comparison — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">167</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>int</code>/<code>float</code> division and type distinction (RULES-B5) in rules — truncating int÷int, float division stays float, div-by-zero denies, <code>is int</code>/<code>is float</code> distinct</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-int-float-and-division</code> — production Firestore Rules Test API verdicts for corpus pack "int-float-and-division", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator narrows a float-valued payload field toward int on the float-payload case, unlike production which preserves the float type — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">168</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>List.concat()</code>/<code>removeAll()</code>/<code>toSet()</code> (Item 5.2) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-list-methods-concat-removeall-toset</code> — production Firestore Rules Test API verdicts for corpus pack "list-methods-concat-removeall-toset", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">169</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Map.get(key, default)</code>, including list-form nested-path traversal (Item 3), in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-map-get-string-and-list-form</code> — production Firestore Rules Test API verdicts for corpus pack "map-get-string-and-list-form", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">170</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>matches()</code> as an anchored full-string RE2 match (RULES-B4) in rules — a pattern matching only a substring is <code>false</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-matches-full-string-regex</code> — production Firestore Rules Test API verdicts for corpus pack "matches-full-string-regex", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">171</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>Path</code> wrapper, <code>path()</code> constructor, and <code>Path.bind()</code> (Item 5.4) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-path-constructor-and-bind</code> — production Firestore Rules Test API verdicts for corpus pack "path-constructor-and-bind", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator treats <code>path()</code> as idempotent on an already-Path argument where production denies — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">172</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Own-keys-only map membership and constructor-access denial (RULES-B7) in rules — <code>'toString' in map</code> is <code>false</code>, <code>.constructor</code> access errors (no JS prototype-chain leakage)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-prototype-chain-keys</code> — production Firestore Rules Test API verdicts for corpus pack "prototype-chain-keys", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">173</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Range-slice <code>[i:j]</code> syntax for <code>List</code> and <code>String</code> (Item 4) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-range-slice-list-and-string</code> — production Firestore Rules Test API verdicts for corpus pack "range-slice-list-and-string", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>. simulator clamps an out-of-bounds slice end to the collection length on both the list and string OOB-slice cases; production denies — pinned KNOWN_DIVERGENCE</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">174</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Set.difference()</code>/<code>union()</code>/<code>intersection()</code> (Item 5.1) in rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-set-algebra-difference-union-intersection</code> — production Firestore Rules Test API verdicts for corpus pack "set-algebra-difference-union-intersection", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">175</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">String-literal escape handling feeding <code>matches()</code> (Class B) in rules — <code>\\.</code> is unescaped before RE2 compilation, not forwarded raw to a JS <code>RegExp</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-string-literals-and-regex</code> — production Firestore Rules Test API verdicts for corpus pack "string-literals-and-regex", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">176</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Missing-field access as a runtime error (RULES-B2) in rules — <code>typo == null</code> denies (missing access is not null); <code>!(key in map)</code> is the real absence check</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-undefined-field-access</code> — production Firestore Rules Test API verdicts for corpus pack "undefined-field-access", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">177</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Explicit <code>UNSUPPORTED</code> reporting for unimplemented built-ins (Item 0.A) in rules — an unimplemented built-in abstains rather than silently DENYing</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>oracle:rules-firestore-unsupported-feature-witness</code> — production Firestore Rules Test API verdicts for corpus pack "unsupported-feature-witness", replayed verdict-for-verdict against the local rules simulator by <code>unit:rules/oracle-conformance.test.ts</code>; all cases match production.</div></div>
</details>
</div>

## Storage rules engine — `parseStorageRules` / `evaluateStorageRules` (rules-storage corpus)

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
<div class="compat-evidence"><div class="compat-probe">STALE ROW, corrected 2026-07-10: production capture proves the evaluator already supports the full six-verb grant surface (umbrella read→{get,list}, write→{create,update,delete}, single granular grants, comma-separated grants, per-verb deny-by-default), matching production verdict-for-verdict on 12 of the pack's 13 non-existence cases. <code>oracle:rules-storage-verbs-umbrella-granular</code> (all <code>read</code>/<code>write</code>/<code>get</code>/comma-verb cases). One related existence-semantics case in the same pack diverges — pinned separately as a KNOWN_DIVERGENCE, not a granular-verb gap.</div></div>
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
</div>
