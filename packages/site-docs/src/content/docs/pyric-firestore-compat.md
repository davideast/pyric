---
title: "pyric/firestore compatibility matrix"
navLabel: "Firestore"
group: "Compatibility"
section: ""
order: 8001
---
<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/firestore` compatibility matrix

The single readable contract for "what this shim guarantees vs the
production `firebase/firestore` SDK."

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

Probe references: `playground:<name>` means a fixture under
`packages/playground/scripts/fixtures/<name>.tsx`. `unit:<file>`
means a Bun test in `packages/pyric/test/firestore/<file>`.

Targets:
- **sandbox** — frozen-ctx target built via `getFirestore(ctx: SandboxContext)`. Identity baked in at handle-construction.
- **sandbox-live** — live-identity target built via `getFirestore(sandbox: Sandbox)`. Every op re-reads `sandbox.currentUser`. The playground preview always uses this flavor.
- **prod** — `firebase/firestore` target built via `getFirestore(app: FirebaseApp)`. Identity comes from `firebase/auth`'s `currentUser`.

---

## `getFirestore(target)` — initializer

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">1</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getFirestore(ctx)</code> returns a tagged sandbox-target handle (frozen identity)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">2</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getFirestore(sandbox)</code> returns a tagged sandbox-live handle (per-op identity)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">3</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getFirestore(app)</code> returns a tagged prod target</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">4</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getFirestore(undefined)</code> — wrapped in the playground preview to default to the sandbox; raw call delegates to prod which throws <code>app/no-app</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:firestore-bare-getfirestore</code> — fix from PR #397 + oracle: <code>scripts/oracle/observations/firestore-bare-getfirestore-no-default-app.json</code> (<code>code: 'app/no-app'</code> against blockingfun, fb-js-sdk 12.13.0 — confirms prod throw shape)</div>
<div class="compat-note">(wrap)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">5</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Two <code>getFirestore(sandbox)</code> calls share state (same underlying <code>LocalEnvironment</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("two handles share the same sandbox")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">6</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Handle dispatch by <code>TARGET_SYMBOL</code> brand — refs/queries route to their owning target via <code>refToTarget</code> WeakMap</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("throws TypeError for refs not produced by this package")</div></div>
</details>
</div>

## Path constructors — `doc` / `collection` / `collectionGroup`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">7</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>doc(db, path)</code> returns a tagged <code>DocumentReference</code> with <code>id</code> / <code>path</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">8</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>doc(db, 'a', 'b', 'c', 'd')</code> joins variadic path segments</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">9</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>collection(db, path)</code> returns a tagged <code>CollectionReference</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">10</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>doc(coll, id)</code> appends under a collection ref</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">11</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>doc(coll)</code> (no id) mints an auto-id <code>DocumentReference</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">12</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>collection(docRef, name)</code> builds a subcollection ref</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">13</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>collectionGroup(db, id)</code> returns a query spanning every collection with that id</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("gathers documents across every parent collection")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">14</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Unknown ref (not produced by this package) → <code>TypeError</code> with "unrecognized reference"</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">15</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Held doc/coll ref under <code>sandbox-live</code> re-resolves to the chainable under the current user at op time (via rebuild closure)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("held doc ref re-resolves under the current user")</div></div>
</details>
</div>

## `getDoc(ref)` — single-doc read

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">16</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>DocumentSnapshot</code> with <code>id</code>, <code>exists</code> (method form), <code>data()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">17</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>snap.exists</code> is normalized to method form (<code>snap.exists()</code> returns boolean) to match the modular SDK</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:firestore-onsnapshot</code> (bundled, assertion-shape compat) + <code>playground:firestore-row-17-snap-exists-method</code> (one-claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">18</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>snap.data()</code> returns <code>undefined</code> for missing doc</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">19</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>snap.ref</code> is tagged so it routes through <code>targetOf</code> in follow-up ops</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">20</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Re-evaluates rules under current user on every call (sandbox-live) — read denied throws <code>permission-denied</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("doc read denied when current user lacks read access"), oracle: <code>scripts/oracle/observations/firestore-read-denied-error-code.json</code> (prod <code>getDoc</code> on a denied path throws a <code>FirebaseError</code> with <code>.code === 'permission-denied'</code>, <code>.message === 'Missing or insufficient permissions.'</code>, <code>instanceof Error</code>)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">21</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Rules denial throws <code>SandboxError('permission-denied', …)</code> on sandbox; <code>FirebaseError('permission-denied')</code> on prod</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: same code, different class — both expose <code>.code === 'permission-denied'</code>. Oracle-locked: <code>scripts/oracle/observations/firestore-rules-denied-error.json</code> — prod throws a <code>FirebaseError</code> (name + constructor name both <code>FirebaseError</code>), <code>.code === 'permission-denied'</code>, <code>.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'</code>, and the value is an <code>instanceof Error</code>.</div></div>
</details>
</div>

## `getDocs(query)` — bulk read

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">22</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns <code>QuerySnapshot</code> with <code>size</code>, <code>empty</code>, <code>docs</code> (<code>QueryDocumentSnapshot[]</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-query</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">23</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Each <code>snap.docs[i].ref</code> is tagged for follow-up ops</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox-live: re-evaluates filters under the current user (different docs visible per identity)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("query results re-evaluate under the current user")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Query reads enforce security rules (FS-B1)</strong> — a deny-all / auth-gated rule set throws <code>permission-denied</code>. Pre-FS-B1 query reads went through the rules-bypassing <code>listDocuments</code> and returned the whole collection.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/query-rules-enforcement.test.ts</code> (deny-all + auth-gated <code>getDocs</code>/aggregate), <code>unit:admin-compat/per-op-auth.test.ts</code> ("Query.get enforces rules")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">24b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Enforcement follows production's QUERY-PROOF model (RULES-B11)</strong> — "rules are not filters": a doc-data-dependent <code>list</code> rule (<code>resource.data.visibility == 'public'</code>, <code>resource.data.owner == request.auth.uid</code>) is ALLOWED when the query's <code>where()</code> equalities discharge it and the whole query is <code>permission-denied</code> otherwise — never silently truncated to the readable subset. Per-doc <code>get</code> rules do NOT filter query results (the <code>list</code> rule alone governs queries — granular-operations docs). Applies to <code>getDocs</code>, aggregates, and <code>onSnapshot</code> alike. Pre-fix: rules-as-filters (per-doc <code>get</code> omission) + blanket denial of every doc-data-dependent list, even provable ones.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/query-proof-enforcement.test.ts</code> (provable/unprovable getDocs + onSnapshot, owner-pinned uid, get-rules-don't-filter, request.query.limit; verified failing pre-fix), <code>unit:simulator/local-environment.test.ts</code> (Slice 6 — flipped from per-doc-filter assertions); prod truth: firebase.google.com/docs/firestore/security/rules-query</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">24c</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Query-proof <strong>prover scope is conservative</strong> — only top-level AND-conjunct <code>resource.data.&lt;field&gt; == &lt;literal&gt;</code> predicates (with <code>request.auth.uid</code> pinned to the caller) are dischargeable by <code>where(field, '==', value)</code>. Disjunctions over doc data, inequality/range proofs (<code>resource.data.score &gt; 10</code> + <code>where('score','&gt;',10)</code>), <code>in</code>-operand proofs, and nested-path predicates conservatively DENY the whole query where production's prover may allow it. Never a false ALLOW — the conservative direction prod also takes for unprovable queries.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/query-proof.test.ts</code> (conservative-reject cases); divergence is deny-only (no rule-violating doc can leak)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">25</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Empty result for a collection with no docs (<code>size === 0</code>, <code>empty === true</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
</div>

## `setDoc(ref, data[, options])` — full write

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">26</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">No options → replaces the existing document entirely</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("setDoc default replaces")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">27</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>{ merge: true }</code> → <strong>deep-merges nested maps</strong> (FS-B6), preserving unspecified fields at every level: <code>setDoc({a:{b:2}}, {merge:true})</code> over <code>{a:{c:1}}</code> yields <code>{a:{b:2,c:1}}</code>. Pre-FS-B6 the wrapper shallow-replaced the whole <code>a</code> map.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>unit:admin-compat/field-path-merge.test.ts</code> (FS-B6 nested deep-merge; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">28</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>{ mergeFields: [...] }</code> → writes only the listed <strong>dot-separated field paths</strong> into the existing doc (FS-B6); other keys in <code>data</code> are ignored, other fields in the existing doc preserved. <code>mergeFields: ['a.b']</code> reaches into a nested map.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>unit:admin-compat/field-path-merge.test.ts</code> (dotted mergeField)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">29</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Passing both <code>merge</code> and <code>mergeFields</code> — <code>mergeFields</code> wins on sandbox (matches JS SDK effective behavior)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">30</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sentinels (<code>serverTimestamp</code>, <code>increment</code>, <code>arrayUnion</code>, <code>arrayRemove</code>, <code>deleteField</code>) resolve in the same call</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code>, oracle: <code>scripts/oracle/observations/firestore-row-30-sentinels-in-setdoc.json</code> — <code>setDoc({createdAt: serverTimestamp(), count: 5, tags: ['a']})</code> followed by <code>getDoc</code> returns <code>createdAt</code> as a <code>Timestamp</code> instance (constructor name <code>Timestamp</code>, has <code>seconds</code> + <code>nanoseconds</code>), <code>count === 5</code> (number), <code>tags === ['a']</code>. Sentinels resolve server-side and the follow-up read sees concrete values, not the sentinel placeholders.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">31</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Converter (via <code>withConverter</code>) runs <code>toFirestore(data)</code> before the write</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("withConverter on a DocumentReference round-trips")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">32</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Rules-denied write throws <code>permission-denied</code> (sandbox) / <code>FirebaseError</code> (prod)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("getDoc denies when rules reject"), <code>playground:rules-data-validation</code>, oracle: <code>scripts/oracle/observations/firestore-write-denied-error-code.json</code> (prod <code>setDoc</code> on a denied path throws a <code>FirebaseError</code> with <code>.code === 'permission-denied'</code>, <code>.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'</code>, <code>instanceof Error</code>)</div></div>
</details>
</div>

## `updateDoc(ref, data)` — partial write

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">33</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Merges <code>data</code> into the existing doc; missing fields preserved. <strong>Top-level keys are dot-separated FieldPaths</strong> (FS-B5): <code>updateDoc({'a.b': 2})</code> sets the nested leaf <code>a.b</code> (preserving <code>a.c</code>), not a literal <code>"a.b"</code> key; a single-segment map value replaces that field wholesale; <code>deleteField()</code> at a dotted path removes the nested leaf.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>unit:admin-compat/field-path-merge.test.ts</code> (FS-B5 dot-path nested write + delete; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">34</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>not-found</code> (sandbox) / <code>FirebaseError('not-found')</code> (prod) on missing doc</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> (implicit in writes-fail-on-missing tests), oracle: <code>scripts/oracle/observations/firestore-updatedoc-missing-error.json</code> (prod throws <code>FirebaseError</code> with <code>code: 'not-found'</code>, message <code>"5 NOT_FOUND: No document to update: …"</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">35</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Does NOT run a converter — partial updates don't have a typed home (matches JS SDK)</span></summary>
<div class="compat-evidence"><div class="compat-probe">(documented in <code>withConverter</code> block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">36</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sentinels resolve mid-update (<code>increment(1)</code> against an existing numeric field, etc.)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code>, oracle: <code>scripts/oracle/observations/firestore-row-36-sentinels-in-updatedoc.json</code> — after <code>setDoc({count: 5, tags: ['a'], oldField: 'keep-then-remove'})</code> then <code>updateDoc({count: increment(3), tags: arrayUnion('b'), oldField: deleteField()})</code>, the follow-up <code>getDoc</code> returns <code>count: 8</code>, <code>tags: ['a', 'b']</code>, and <code>oldField</code> absent from the doc (the deleteField sentinel actually removes the key). All three sentinels apply in one mid-update commit.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">37</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox-live: each call re-evaluates auth (alice → bob between writes uses bob's auth)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("updateDoc re-evaluates auth per call")</div></div>
</details>
</div>

## `deleteDoc(ref)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">38</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Removes the document; subsequent <code>getDoc</code> returns <code>exists()===false</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">39</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Idempotent — <code>deleteDoc</code> on missing doc resolves without throwing (matches JS SDK)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:deletedoc-missing.test.ts</code>, <code>playground:firestore-deletedoc-missing</code>, oracle: <code>scripts/oracle/observations/firestore-deletedoc-missing.json</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">40</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Rules-denied delete throws <code>permission-denied</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> (rules-reject branch), oracle: <code>scripts/oracle/observations/firestore-delete-denied-error-code.json</code> (prod <code>deleteDoc</code> on a denied path throws a <code>FirebaseError</code> with <code>.code === 'permission-denied'</code>, <code>.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'</code>, <code>instanceof Error</code>)</div></div>
</details>
</div>

## `addDoc(coll, data)` — auto-id write

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">41</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returns a tagged <code>DocumentReference</code> with auto-id</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">42</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned ref is usable in subsequent ops (<code>getDoc</code>, <code>setDoc</code>, <code>onSnapshot</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-row-42-adddoc-returned-ref-usable.json</code> — <code>addDoc(coll, {v:1})</code> returned a ref whose <code>.id</code> is a 20-char auto-id; <code>getDoc(ref)</code> returned <code>{v:1}</code> (round-trip), <code>setDoc(ref, {v:2})</code> overwrote without error, follow-up <code>getDoc</code> returned <code>{v:2}</code>, and <code>onSnapshot(ref, cb)</code> registered cleanly and fired once with <code>{exists:true, v:2}</code>. All four follow-up ops succeed on the returned ref without re-tagging.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">43</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox-live: returned ref is a <em>live</em> ref (rebuild closure recorded) so follow-ups re-resolve auth</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("addDoc result is a tagged live ref")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">44</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Converter on the parent collection propagates onto the returned ref</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("addDoc through a converted collection")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">45</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Auto-id format — prod uses 20-char base64-ish IDs; sandbox uses <code>pyric-admin</code>'s auto-id (also opaque, distinct format)</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: IDs are opaque on both sides; format differs but consumer code never parses them. Oracle-locked: <code>scripts/oracle/observations/firestore-adddoc-autoid-format.json</code> — prod auto-ids are 20 characters, all alphanumeric (mixed upper, lower, digits; no other chars). Example: <code>S3PJENMPOk4qcDXol8Ez</code>.</div>
<div class="compat-note">format</div></div>
</details>
</div>

## `withConverter` — typed refs

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">46</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>withConverter(docRef, converter)</code> returns a shell that runs <code>toFirestore</code> on writes, <code>fromFirestore</code> on reads</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">47</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>withConverter(collRef, converter)</code> propagates onto <code>doc(typedColl, id)</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">48</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>withConverter(collRef, converter)</code> propagates through <code>query(typedColl, …)</code> + <code>getDocs()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">49</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>withConverter(ref, null)</code> strips the converter, returns the underlying untyped view</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">50</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Original untyped ref keeps its identity after <code>withConverter(ref, c)</code> (two views, one path)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">51</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>setDoc</code> through a converted ref invokes <code>toFirestore(data)</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">52</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getDoc</code> through a converted ref invokes <code>fromFirestore(snapshot)</code>; <code>.data()</code> returns the typed model</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">53</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>updateDoc</code> through a converted ref does NOT invoke the converter</span></summary>
<div class="compat-evidence"><div class="compat-probe">(documented constraint; matches JS SDK)</div></div>
</details>
</div>

## Query construction — `query` / `where` / `or` / `and` / `orderBy` / `limit`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">54</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>query(coll, where(…), orderBy(…), limit(…))</code> composes constraints in order</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-query</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">55</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>where(field, op, value)</code> — all 10 ops: <code>&lt;</code>, <code>&lt;=</code>, <code>==</code>, <code>&gt;=</code>, <code>&gt;</code>, <code>!=</code>, <code>in</code>, <code>not-in</code>, <code>array-contains</code>, <code>array-contains-any</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> (canonical query test)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">55a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Existence + null filter guards (FS-B7)</strong> — a doc missing the filter field is never returned by <code>==</code>/<code>&lt;</code>/<code>&lt;=</code>/<code>&gt;</code>/<code>&gt;=</code>/<code>in</code>/<code>!=</code>/<code>not-in</code>; <code>!=</code> and <code>not-in</code> additionally exclude null-valued docs and require the field to exist; a <code>null</code> in a <code>not-in</code> operand list matches nothing. Pre-FS-B7, <code>!=</code>/<code>not-in</code> matched missing-field and null docs.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/inequality-existence-guards.test.ts</code> (verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">56</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>or(...)</code> composite — at least one sub-filter matches</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("or() matches docs where any sub-filter matches"), oracle: <code>scripts/oracle/observations/firestore-or-composite.json</code> (4 seeded docs; <code>or(where('x','==',1), where('y','==',2))</code> returned the exact union <code>{match-both, match-x, match-y}</code> — no implicit index required against cloud Firestore)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">57</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>and(...)</code> composite — every sub-filter matches</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("and() requires every sub-filter"), oracle: <code>scripts/oracle/observations/firestore-and-composite.json</code> (4 seeded docs; <code>and(where('x','==',1), where('y','==',2))</code> returned only the intersection <code>{match-both}</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">58</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Nested <code>or</code> / <code>and</code> — full composite tree</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("nested or/and — the canonical composite pattern"), oracle: <code>scripts/oracle/observations/firestore-nested-or-and-composite.json</code> (6 seeded docs; <code>or(and(where('x','==',1), where('y','==',2)), where('z','==',3))</code> returned <code>{inner-and-match, outer-z-match, both-branches}</code> — exact boolean union as predicted)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">59</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>orderBy(field, 'asc'|'desc')</code> — direction parameter</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">59a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Canonical type-order comparison (FS-B3)</strong> — orderBy + range filters compare by Firestore's canonical type order (<code>null &lt; bool &lt; number &lt; timestamp &lt; string &lt; bytes &lt; ref &lt; geopoint &lt; array &lt; map</code>), then within-type; numbers sort numerically (not lexicographically), NaN sorts as the smallest number, and range filters (<code>&lt;</code>/<code>&lt;=</code>/<code>&gt;</code>/<code>&gt;=</code>) only match same-type values. Pre-FS-B3 the comparator fell back to <code>String(a).localeCompare(String(b))</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/canonical-type-order.test.ts</code> (cross-type ranking, numeric sort, NaN, timestamps, arrays; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">59b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>orderBy excludes missing-field docs (FS-B3)</strong> — a doc lacking an orderBy field is omitted from the result (matches prod); pre-fix it was sorted in via <code>compareValues(undefined, …)</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/canonical-type-order.test.ts</code> ("excludes the missing-field doc")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">59c</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Implicit orderBy + <code>__name__</code> tiebreak (FS-B8)</strong> — the query's sort is normalized to: explicit orderBy clauses, then an implicit order on each inequality-filtered field, then a final document-key (<code>__name__</code>) clause. Equal-valued docs sort deterministically by key; a <code>where('x','&gt;',v)</code> with no explicit orderBy returns docs ordered by <code>x</code>. Mirrors <code>clones/.../core/query.ts:queryNormalizedOrderBy</code>. Pre-FS-B8 equal-valued docs were nondeterministic and inequality results came back in insertion order.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/implicit-order-name.test.ts</code> (key tiebreak, snapshot-cursor disambiguation, implicit inequality order; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">60</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>limit(n)</code> — caps result count</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">61</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>limitToLast(n)</code> — trailing n in ordered result (requires <code>orderBy</code>). Sandbox: the no-orderBy precondition throws a <code>FirestoreError</code> with <code>.code === 'invalid-argument'</code> (FS-B16; pre-fix plain <code>Error</code>s). Prod: the same precondition throws <code>.code === 'unimplemented'</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence, oracle-locked by <code>scripts/oracle/observations/firestore-limittolast-preconditions.json</code>: prod's no-orderBy <code>limitToLast</code> throws code <code>unimplemented</code>, the sandbox throws <code>invalid-argument</code>. Trailing-window semantics with <code>orderBy</code> conform (observed <code>["b"]</code> matches). Both sides pinned in <code>oracle-conformance.test.ts</code>. Cursor/empty-snapshot precondition codes remain per <code>unit:sandbox-target.test.ts</code> + <code>unit:admin-compat/cursors.test.ts</code> (verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">62</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Composite filters AND with other constraints — <code>query(coll, or(...), orderBy(...), limit(...))</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">63</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Passing <code>orderBy</code> / <code>limit</code> into <code>or()</code> / <code>and()</code> → <code>TypeError</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">64</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Zero-arg <code>or()</code> / <code>and()</code> → <code>TypeError</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">65</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Chained queries re-tag for further constraints (<code>query(query(coll, where), orderBy)</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("chained queries are taggable")</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">66</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Index validation against <code>firestore.indexes.json</code> — sandbox uses <code>LocalEnvironment</code>'s lint pass; prod has its own server-side validation</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox can mis-pass a query that prod would reject at the server with <code>failed-precondition</code> if no index exists</div></div>
</details>
</div>

## Cursor pagination — `startAt` / `startAfter` / `endAt` / `endBefore`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">67</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>startAt(...values)</code> — inclusive value cursor (one positional per <code>orderBy</code> clause)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-cursor-startat-inclusive.json</code> (5 seeded docs at pos=[1..5]; <code>query(c, orderBy('pos'), startAt(3))</code> returned exactly <code>[pos-3, pos-4, pos-5]</code> — the cursor doc IS included)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">68</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>startAfter(...values)</code> — exclusive value cursor</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-cursor-startafter-exclusive.json</code> (5 seeded docs at pos=[1..5]; <code>query(c, orderBy('pos'), startAfter(3))</code> returned exactly <code>[pos-4, pos-5]</code> — the cursor doc is EXCLUDED)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">69</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>endAt(...values)</code> — inclusive end cursor</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-cursor-endat-inclusive.json</code> (5 seeded docs at pos=[1..5]; <code>query(c, orderBy('pos'), endAt(3))</code> returned exactly <code>[pos-1, pos-2, pos-3]</code> — the cursor doc IS included)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">70</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>endBefore(...values)</code> — exclusive end cursor</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-cursor-endbefore-exclusive.json</code> (5 seeded docs at pos=[1..5]; <code>query(c, orderBy('pos'), endBefore(3))</code> returned exactly <code>[pos-1, pos-2]</code> — the cursor doc is EXCLUDED)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">71</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>startAt(snapshot)</code> overload — extracts orderBy field values from the snapshot, positioning against the NORMALIZED orderBy (implicit <code>__name__</code>), so it disambiguates equal-valued docs and is <strong>legal without an explicit orderBy</strong> (FS-B8). A VALUE cursor with more values than explicit orderBy clauses throws <code>invalid-argument</code> ("Too many arguments").</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>unit:admin-compat/implicit-order-name.test.ts</code> (snapshot cursor w/o orderBy), <code>unit:admin-compat/cursors.test.ts</code> (value-cursor too-many-args throws with <code>.code</code>)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">72</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>endAt(snapshot)</code> overload</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("endAt(snapshot) trims to-and-including the anchor")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">73</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>startAfter + limit</code> — canonical pagination pattern</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
</div>

## Aggregates — `getCountFromServer` / `getAggregateFromServer` / `count` / `sum` / `average`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">74</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getCountFromServer(query)</code> returns <code>{ data: () =&gt; ({ count: N }) }</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">75</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getCountFromServer</code> honors <code>where</code> filters</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">76</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getAggregateFromServer(query, spec)</code> returns <code>{ data: () =&gt; Record&lt;alias, number|null&gt; }</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">77</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>count()</code> / <code>sum(field)</code> / <code>average(field)</code> compose under one spec</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">78</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>average</code> returns <code>null</code> on empty input (matches JS SDK)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">79</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Aggregates count documents server-side without paying read cost per doc in prod; sandbox computes locally (no cost model)</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: cost behavior differs, observable shape identical. Oracle-locked: <code>scripts/oracle/observations/firestore-count-aggregate-shape.json</code> — <code>getCountFromServer().data()</code> returns <code>{ count: &lt;number&gt; }</code> (single key, no other fields). Empty query returns <code>count: 0</code> (not <code>null</code>/<code>undefined</code>); seeded 3 docs returns <code>count: 3</code>; filtered query honors the <code>where</code> constraint (<code>count: 2</code>).</div></div>
</details>
</div>

## `onSnapshot(refOrQuery, …)` — listeners

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">80</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>onSnapshot(docRef, cb)</code> fires the initial snapshot <strong>asynchronously</strong> — never synchronously during the registering call. Prod empirically lands after a <code>setTimeout(0)</code> macrotask (the fire travels the network listener channel); the sandbox defers through its delivery scheduler (microtask). The matrix contract is "asynchronous, never during register", not "exactly the next microtask"</span></summary>
<div class="compat-evidence"><div class="compat-probe">Aligned via the listener delivery scheduler (<code>src/sandbox/firestore/local-environment.ts</code>): the initial fire is enqueued and delivered on a microtask, never during register — closing the divergence this row previously documented (the sandbox used to fire synchronously during registration; the sync-body tests were migrated to the flush/await idiom). Machine-checked against <code>scripts/oracle/observations/firestore-row-80-onsnapshot-fires-initial.json</code> (<code>firstFireSyncDuringRegister: false</code>, fire count + contents) in <code>oracle-conformance.test.ts</code>; also <code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-onsnapshot</code> (bundled) + <code>playground:firestore-row-80-onsnapshot-fires-initial</code> (one-claim).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">81</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>onSnapshot(query, cb)</code> fires on collection writes</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-row-81-onsnapshot-query-fires-on-write.json</code> — listener on <code>query(coll)</code> saw 1 initial fire (empty, <code>size:0</code>), then one fire per write: <code>addDoc</code> → <code>size:1</code>, <code>setDoc(coll, 'known-id')</code> → <code>size:2</code>, <code>deleteDoc(addedRef)</code> → <code>size:1</code>. Total 4 fires, each reflecting the current collection state. Every collection-level write produces a distinct fire. (Note: this oracle used a <em>filterless</em> <code>query(coll)</code>, which masked FS-B2 — see row 81a.)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">81a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Filtered listeners honor <code>where</code> / <code>orderBy</code> / <code>limit</code> (FS-B2)</strong> — <code>onSnapshot(query(coll, where(…), orderBy(…), limit(…)), cb)</code> delivers the same membership as <code>getDocs(sameQuery)</code>: non-matching docs are excluded on the initial fire and on writes; ordering + limit are applied. Pre-FS-B2 the <code>SnapshotTarget</code> dropped all constraints and delivered the whole collection.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:onsnapshot-query-constraints.test.ts</code> (filtered/ordered/limited listeners; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">81b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Listener <code>.data()</code> matches <code>getDoc</code> shape (FS-B10)</strong> — the <code>onSnapshot</code> doc + query snapshot path runs the same read-path translation as <code>getDoc</code>/<code>getDocs</code>, so <code>snap.data().createdAt</code> is a compat <code>Timestamp</code> (<code>{seconds, nanoseconds}</code>), not the rules-internal wrapper (<code>{seconds, nanos}</code> + <code>typeName</code>, no <code>nanoseconds</code>). Pre-FS-B10 a listener leaked the internal shape while the single-doc read returned the compat shape.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulator/listener-read-translation.test.ts</code> (doc + query listener Timestamp shape; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">82</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Initial fire for a missing doc has <code>exists() === false</code> and <code>data() === undefined</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:firestore-onsnapshot</code> (bundled) + <code>playground:firestore-row-82-onsnapshot-missing-initial</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-82-onsnapshot-missing-initial.json</code> — single initial fire with <code>snap.exists() === false</code>, <code>snap.data() === undefined</code>, <code>hasPendingWrites: false</code>, <code>fromCache: false</code>. The missing-doc fire is server-confirmed, not a cache speculation.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">83</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Returned <code>Unsubscribe</code> stops further fires</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-row-83-unsubscribe-stops-fires.json</code> — pre-unsubscribe write fired the listener (initial fire + write fire = 2 fires); after <code>unsub()</code>, a subsequent <code>setDoc</code> produced 0 additional fires (<code>postUnsubFireCount: 0</code>). Unsubscribe is durable; no fires arrive on the released callback after a 1.5s settle window.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">84</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Observer object form <code>{next, error, complete}</code> works alongside the function form. <strong>Partial observers are accepted — <code>{ error: fn }</code> with no <code>next</code> registers and routes denials to <code>error</code> (FS-B14, <code>isPartialObserver</code> semantics from upstream <code>api/observer.ts</code>); pre-fix it was misrouted as <code>SnapshotListenOptions</code> and threw "missing next handler".</strong></span></summary>
<div class="compat-evidence"><div class="compat-probe">oracle: <code>scripts/oracle/observations/firestore-row-84-observer-object-form.json</code> — registered two listeners on the same doc: one as a bare function <code>(snap) =&gt; …</code>, one as <code>{next, error, complete}</code>. Both fired once on initial (<code>{v:0}</code>) and again after a write (<code>{v:1}</code>), capturing identical data. <code>error</code> never fired (no rule denial), <code>complete</code> never fired on <code>unsub()</code> (Firebase treats unsubscribe as a teardown, not a "complete" signal — the observer's <code>complete</code> callback is reserved for terminal stream end, which <code>onSnapshot</code> does not produce). The two registration shapes are interchangeable for fire dispatch. <code>unit:onsnapshot-observer-discriminator.test.ts</code> (error-only observer; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">85</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>SnapshotListenOptions.includeMetadataChanges</code> — one write yields the pending-write local echo (<code>hasPendingWrites: true</code>) then, for metadata listeners, the settled ack fire: default listener 2 fires, metadata listener 3</span></summary>
<div class="compat-evidence"><div class="compat-probe">Aligned via the listener delivery scheduler (<code>src/sandbox/firestore/local-environment.ts</code> + <code>snapshot-listeners.ts</code>): the write echo carries <code>hasPendingWrites: true</code> and <code>includeMetadataChanges</code> listeners receive the settled metadata-only ack, reproducing prod's recorded 2/3-fire sequences exactly. Machine-checked against <code>scripts/oracle/observations/firestore-include-metadata-changes.json</code> in <code>oracle-conformance.test.ts</code> (fire counts and per-fire <code>hasPendingWrites</code> sequence asserted from the capture)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">86</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Snapshot's <code>.ref</code> / <code>.docs[i].ref</code> are tagged so consumer code can pass them to follow-up ops</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">87</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox-live: listener registered as alice keeps emitting alice's view after <code>setUser → bob</code> (identity frozen at subscribe)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("listener registered as alice keeps emitting alice's view")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">88</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Sandbox-live: listener registered as anonymous keeps firing after sign-in (anonymous → signed-in identity persists per listener)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("listener registered as anonymous on /public keeps firing after sign-in")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">89</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Snapshot's ref is usable in follow-up ops under the new user (the ref is live, the listener identity is frozen — distinct)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("snapshot ref is usable in subsequent ops under the new user"), oracle: <code>scripts/oracle/observations/firestore-row-89-snapshot-ref-usable.json</code> — captured <code>snap.ref</code> from a docRef listener's first fire and <code>snap.docs[0].ref</code> from a query listener's first fire; both refs round-trip via <code>getDoc</code> (returning the same data) and <code>setDoc</code> (writes succeed and a follow-up <code>getDoc</code> confirms the new payload). <code>snap.ref.path</code> equals the original <code>doc(coll, id).path</code>. Both snap-ref shapes are first-class refs in prod, matching sandbox's tagged-ref guarantee.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">90</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Preview tree mounts the user's component exactly once per session load — no observer subscriptions leak across parallel <code>AppPreview</code> instances. Root cause: <code>PlaygroundPage</code> rendered both <code>WorkspacePanel</code>'s and the mobile <code>AppPanel</code>'s <code>AppPreview</code> unconditionally (the latter <code>md:hidden</code> on desktop but still mounted), producing two live preview trees subscribing in parallel. Fixed by gating <code>AppPanel</code> on <code>useIsMobile() &amp;&amp; mobileTab === 'app'</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:preview-single-mount</code></div></div>
</details>
</div>

## `runTransaction(db, fn)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">91</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Atomic read-write — all reads in <code>fn</code> see a consistent snapshot, writes commit together</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-transaction</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">92</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Identity is frozen at <code>runTransaction</code> start — mid-transaction <code>setUser</code> does NOT re-auth in-flight reads</span></summary>
<div class="compat-evidence"><div class="compat-probe">(documented invariant)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">93</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Retry behavior — prod retries on contention up to 5 times; sandbox is single-threaded, no contention possible</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: contention story not modeled; sandbox just runs once</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">94</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Throws <code>FirebaseError('permission-denied')</code> on rule denial inside the transaction (the inner write's denial — not a generic <code>aborted</code>). Sandbox throws <code>FirestoreCompatError</code> with the same <code>code: 'permission-denied'</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> (writes-reject branch), oracle: <code>scripts/oracle/observations/firestore-transaction-rules-denied-error.json</code> (prod throws <code>FirebaseError</code> with <code>code: 'permission-denied'</code>, NOT <code>aborted</code>; the inner callback ran once and the rules-rejected write surfaces as a regular permission-denied at commit)</div></div>
</details>
</div>

## `writeBatch(db)`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">95</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>batch.set</code> / <code>batch.update</code> / <code>batch.delete</code> queue mutations</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-batch</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">96</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>batch.commit()</code> applies all queued writes atomically — success path commits all queued mutations together; failure path (one write violating rules) rejects the <strong>whole</strong> batch with no partial application</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, oracle: <code>scripts/oracle/observations/firestore-row-96-batch-commit-atomic.json</code> — success path: a batch with <code>set</code> (fresh doc), <code>update</code> (existing doc), and <code>delete</code> (existing doc) all land in a single commit (<code>allApplied: true</code>). Failure path: a batch with one write targeting a path <strong>outside</strong> <code>pyric_oracle/*</code> rejects with <code>code: 'permission-denied'</code> and leaves the would-have-set doc absent and the would-have-updated doc at its original value (<code>noPartialApply: true</code>) — atomicity verified end-to-end.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">97</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Batch is tagged on construction — passing a prod-target batch into a sandbox op (or vice-versa) is a type error</span></summary>
<div class="compat-evidence"><div class="compat-probe">(route table consistency)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">98</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Batch identity is frozen at construction (per current implementation)</span></summary>
<div class="compat-evidence"><div class="compat-probe">(documented invariant)</div></div>
</details>
</div>

## Sentinels — `serverTimestamp` / `increment` / `arrayUnion` / `arrayRemove` / `deleteField` / `FieldValue` / `Timestamp`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">99</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>serverTimestamp()</code> resolves to a <code>Timestamp</code> after the write commits</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code> (bundled) + <code>playground:firestore-row-99-servertimestamp-resolves</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-99-servertimestamp-resolves-to-timestamp.json</code> — <code>setDoc({at: serverTimestamp()})</code> then <code>getDoc</code> yields <code>at instanceof Timestamp === true</code>, <code>constructor.name === 'Timestamp'</code>, with both <code>.seconds</code> (number) and <code>.nanoseconds</code> (number) present.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">100</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>increment(n)</code> atomically bumps a numeric field; <code>null</code>/missing field starts from 0</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code> (bundled) + <code>playground:firestore-row-100-increment-bumps-numeric</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-100-increment-bumps-numeric.json</code> — <code>setDoc</code> with no <code>count</code> field then <code>updateDoc({count: increment(5)})</code> yields <code>count === 5</code> (starts from 0). Follow-up <code>increment(3)</code> → 8, then <code>increment(-2)</code> → 6 (negative deltas apply, increments accumulate).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">101</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>arrayUnion(...values)</code> de-dupes against existing members <strong>and</strong> against duplicate args within the same call</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code> (bundled) + <code>playground:firestore-row-101-arrayunion-dedupes</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-101-arrayunion-dedupes.json</code> — <code>setDoc({tags: ['a','b']})</code> then <code>updateDoc({tags: arrayUnion('b','c')})</code> yields <code>['a','b','c']</code> (single <code>b</code>, not double). Follow-up <code>updateDoc({tags: arrayUnion('d','d','a')})</code> yields <code>['a','b','c','d']</code> — both inline duplicate args and existing-member duplicates are de-duped.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">102</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>arrayRemove(...values)</code> strips matching members; values not present in the array are silent no-ops</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:firestore-sentinels</code> (bundled) + <code>playground:firestore-row-102-arrayremove-strips</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-102-arrayremove-strips.json</code> — <code>setDoc({tags: ['a','b','c']})</code> then <code>updateDoc({tags: arrayRemove('b','d')})</code> yields <code>['a','c']</code>: <code>'b'</code> removed, <code>'d'</code> (absent) was a silent no-op (no error).</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">103</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>deleteField()</code> removes a field on update — the field is fully absent from the returned data, not merely undefined-valued. Legal at the top level or via a <strong>dot-path</strong> (<code>{'a.b': deleteField()}</code> removes the nested leaf — FS-B5). <strong>Nested inside a map literal (<code>{a: {b: deleteField()}}</code>) it throws <code>invalid-argument</code> (FS-B13)</strong> instead of destroying the sibling map.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:firestore-sentinels</code> (bundled) + <code>playground:firestore-row-103-deletefield-removes-field</code> (one-claim), oracle: <code>scripts/oracle/observations/firestore-row-103-deletefield-removes-field.json</code> — <code>setDoc({keep:1, remove:2})</code> then <code>updateDoc({remove: deleteField()})</code> yields a doc whose <code>data()</code> has keys <code>['keep']</code> only, <code>keep === 1</code> preserved; <code>unit:admin-compat/nested-delete-field.test.ts</code> (nested → invalid-argument; dot-path + top-level still valid; verified failing pre-fix)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">104</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Timestamp</code> shape (<code>{seconds, nanoseconds}</code>) is identical between prod and sandbox — round-trips cleanly</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">104b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong><code>Timestamp</code> nanos normalization + value API (FS-B12)</strong> — <code>fromMillis</code>/<code>fromDate</code>/<code>now</code> derive <code>nanoseconds</code> as <code>floor((ms - seconds<em>1000) </em> 1e6)</code> so it is always non-negative; <code>fromMillis(-500).toMillis()</code> round-trips to -500 (was -1500). The class ships <code>isEqual</code> / <code>toString</code> / <code>toJSON</code> / <code>valueOf</code>, mirroring <code>clones/.../lite-api/timestamp.ts</code>.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:admin-compat/timestamp-api.test.ts</code> (negative-millis round-trip + value API; pre-fix lacked the methods and mis-normalized)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">104a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Unified Timestamp storage (FS-B4)</strong> — a <code>Timestamp</code> written directly via the modular SDK (<code>setDoc({createdAt: Timestamp.now()})</code>) is stored as the same rules-internal <code>Timestamp</code> that <code>serverTimestamp()</code>/<code>Date</code> resolve to. Pre-FS-B4 a user-written <code>Timestamp</code> was the compat class only (not a <code>RulesValue</code>), so <code>request.resource.data.createdAt is timestamp</code> returned <strong>false</strong> for it while a <code>serverTimestamp()</code> write passed the same rule, and the two paths stored two different classes. A write-boundary converter now normalizes both.</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/sandbox-converters/user-timestamp.test.ts</code> (<code>is timestamp</code> passes for a user Timestamp; unified storage class; range-filter regression guard — verified failing pre-fix by removing the converter registration)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">105</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>FieldValue</code> re-exported from <code>pyric-admin</code> (alias of <code>ChainFieldValue</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe">type-only smoke</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">105a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><strong>Sentinel overwrite on type mismatch (FS-B11)</strong> — <code>increment(n)</code> on a non-numeric (or absent) prior OVERWRITES using a base value of 0 (result <code>n</code>); <code>arrayUnion</code>/<code>arrayRemove</code> on a non-array prior coerce the base to <code>[]</code>. Pre-FS-B11 these threw and surfaced as <code>invalid-argument</code> denials. Mirrors <code>clones/.../model/transform_operation.ts</code> (<code>computeTransformOperationBaseValue</code>, <code>coercedFieldValuesArray</code>).</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:simulator/converters/fieldvalue.test.ts</code> (FS-B11 overwrite block + flipped unit/integration/batch cases; verified failing pre-fix)</div></div>
</details>
</div>

## Scalar types — `Bytes` / `GeoPoint` / `FieldPath` / `documentId`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">106</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Constructors are re-exported from <code>firebase/firestore</code> — <code>new Bytes(…)</code>, <code>new GeoPoint(lat, lng)</code>, <code>new FieldPath(...)</code>, <code>documentId()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("Bytes / GeoPoint / FieldPath / documentId are re-exported")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">107</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>documentId()</code> works in <code>where(documentId(), 'in', [...])</code> against the sandbox</span></summary>
<div class="compat-evidence"><div class="compat-probe">(chainable adapter recognizes the FieldPath sentinel)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">108</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>FieldPath</code> (nested) works in queries against sandbox</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">109</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Bytes</code> round-trip through the sandbox wire encoder — <code>Bytes</code> written via <code>setDoc</code> reads back as a <code>Bytes</code> instance with the same base64 representation</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts</code> + <code>unit:packages/pyric/test/firestore/sandbox-target.test.ts</code> ("Bytes + GeoPoint round-trip"), oracle: <code>scripts/oracle/observations/firestore-row-109-bytes-roundtrip.json</code> — <code>setDoc({payload: Bytes.fromUint8Array([1,2,3,4])})</code> then <code>getDoc</code> yields <code>payload instanceof Bytes === true</code>, <code>payload.constructor.name === 'Bytes'</code>, <code>payload.toBase64() === 'AQIDBA=='</code>, and <code>payload.toUint8Array()</code> returns <code>[1,2,3,4]</code> against blockingfun. Sandbox converters at <code>packages/pyric/src/sandbox/firestore/converters/bytes-geopoint.ts</code> duck-type-detect <code>fb.Bytes</code> and store as the rules <code>Bytes</code> wrapper; <code>pyric/firestore</code> finalizes the read back to <code>fb.Bytes</code> so consumer code matches prod's <code>instanceof</code> semantics.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">110</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>GeoPoint</code> round-trip through the sandbox wire encoder — <code>GeoPoint</code> written via <code>setDoc</code> reads back as a <code>GeoPoint</code> instance with the same latitude / longitude</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:packages/pyric/test/sandbox/firestore/wire-encoder-bytes-geopoint.test.ts</code> + <code>unit:packages/pyric/test/firestore/sandbox-target.test.ts</code> ("Bytes + GeoPoint round-trip"), oracle: <code>scripts/oracle/observations/firestore-row-110-geopoint-roundtrip.json</code> — <code>setDoc({loc: new GeoPoint(37.7749, -122.4194)})</code> then <code>getDoc</code> yields <code>loc instanceof GeoPoint === true</code>, <code>loc.constructor.name === 'GeoPoint'</code>, <code>loc.latitude === 37.7749</code>, <code>loc.longitude === -122.4194</code> against blockingfun. Sandbox storage uses the rules <code>LatLng</code> wrapper; <code>pyric/firestore</code> finalizes the read back to <code>fb.GeoPoint</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">111</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Vector value type (<code>vector()</code> + <code>VectorValue</code>) round-trip: a vector written via <code>setDoc</code> reads back as a <code>VectorValue</code> with the same components</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code> ("Bytes + GeoPoint + VectorValue round-trip", top-level + nested). <code>vector()</code> / <code>VectorValue</code> re-exported from <code>firebase/firestore</code>; the sandbox converter at <code>converters/vector.ts</code> duck-types the VectorValue and stores the rules <code>Vector</code> wrapper; <code>pyric/firestore</code> finalizes the read back to <code>fb.VectorValue</code>. Oracle observation to follow (cf. #109/#110). <strong>CLIENT surface only:</strong> the web SDK exposes <code>vector()</code> + <code>VectorValue</code> (read/write) but has NO <code>findNearest</code> and NO <code>FieldValue.vector</code>; vector SEARCH is admin/server-only (<code>firebase-admin</code> <code>Query</code>/<code>CollectionReference.findNearest</code> + <code>FieldValue.vector()</code>), out of scope for this client matrix; the admin surface is tracked in the design rationale.</div></div>
</details>
</div>

## Equality helpers — `refEqual` / `queryEqual` / `snapshotEqual`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">112</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>refEqual(a, b)</code> — true when paths match under the same target</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">113</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>refEqual</code> is <code>true</code> for cross-flavor sandbox vs sandbox-live refs at the same path</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("refEqual returns true for live and frozen refs at the same path")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">114</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>refEqual</code> is <code>false</code> for refs at different paths</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">115</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>refEqual(sandboxRef, prodRef)</code> throws <code>TypeError</code> — crossing targets is a programming error</span></summary>
<div class="compat-evidence"><div class="compat-probe">(documented invariant in <code>targetMatch</code>)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">116</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>queryEqual(a, b)</code> — true on identity for sandbox; structural for prod via <code>fb.queryEqual</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence: sandbox does identity-only; prod does deep structural. Oracle-locked: <code>scripts/oracle/observations/firestore-queryequal-structural.json</code> — two independently-built queries with the same <code>where('x','==',1)</code> constraint compare equal in prod (<code>sameQueryBuiltTwice: true</code>), confirming structural semantics. Common use case (caching the same returned query) works on both.</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">117</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>snapshotEqual(a, b)</code>. Prod: returns a boolean — true on identity, false even for two fetches of the same data. Sandbox: <strong>throws</strong> (<code>unrecognized reference</code>) for sandbox-target snapshots instead of returning a boolean</span></summary>
<div class="compat-evidence"><div class="compat-probe">divergence, oracle-locked by <code>scripts/oracle/observations/firestore-snapshotequal-structural.json</code> (<code>identity: true</code>, <code>twoFetchesSameData: false</code> — prod is identity-only, NOT structural; an earlier structural guess was corrected by the oracle). The sandbox routes both args through the ref-tagging path, which does not recognize sandbox <code>QuerySnapshot</code>s, so <code>snapshotEqual</code> throws rather than comparing. Both sides pinned in <code>oracle-conformance.test.ts</code>. Fix candidate: identity-compare sandbox snapshots before the ref-tagging dispatch.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">118</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Cross-flavor <code>refEqual</code> via <code>QuerySnapshot.docs[i].ref</code> works</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("cross-flavor refEqual via QuerySnapshot doc refs")</div></div>
</details>
</div>

## `connectFirestoreEmulator`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">119</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">No-op on sandbox-target handles (the sandbox already IS a local emulator)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">120</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Forwards to <code>fb.connectFirestoreEmulator</code> on prod-target handles</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:prod-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">121</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>mockUserToken</code> option pass-through on prod</span></summary>
<div class="compat-evidence"><div class="compat-probe">type-only smoke</div></div>
</details>
</div>

## Offline / persistence / network family

`enableIndexedDbPersistence`, `enableMultiTabIndexedDbPersistence`,
`clearIndexedDbPersistence`, `enableNetwork`, `disableNetwork`, and
`waitForPendingWrites` are now exported from `pyric/firestore`. Before
this, none of the six existed on the modular surface at all — an app
that called any of them at init (a common pattern) crashed on a
missing named export before it ever ran a read or write.

**Honest-mirror rationale**: the sandbox IS the backend, running
local-first with IndexedDB persistence on by default (the
SharedWorker/`pyric dev` path calls `Sandbox.enablePersistence(...)`
before any app code runs). There is no separate cache tier to opt
into and no network to gate. Each function below does the one
honest thing available in that model — resolve because the promised
behavior is already true, or resolve as a documented no-op because
there is nothing local for it to mean. None of them simulate a
capability the sandbox doesn't have; in particular, `disableNetwork`
does NOT queue writes for later replay — writes still commit
immediately, because there's no real connection to lose.

`terminate` is also now exported from `pyric/firestore` — a genuine
teardown-forward (not a pure no-op) to `Sandbox.dispose()` on sandbox
targets, and to `fb.terminate` on prod targets. See its own row below
for the scope caveat (it tears down the whole `Sandbox`, not a
Firestore-only slice).

## Offline / persistence / network family (continued)

<div class="compat-list">
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">140</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Resolves on sandbox targets — persistence is already the default; does not reject with <code>'failed-precondition'</code> when called after other ops (deliberately more lenient than the real SDK — no cache-init race to protect). Forwards to <code>fb.enableIndexedDbPersistence</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/persistence-network.test.ts</code></div>
<div class="compat-note">no failed-precondition</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">141</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Resolves on sandbox targets — the SharedWorker path already is the one shared store every tab talks to. Forwards to <code>fb.enableMultiTabIndexedDbPersistence</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/persistence-network.test.ts</code></div>
<div class="compat-note">no failed-precondition</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">142</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Maps to <code>Sandbox.clearPersistence()</code> on sandbox targets — actually wipes the persisted blob (honest, not a no-op); already a no-op when persistence was never enabled. Forwards to <code>fb.clearIndexedDbPersistence</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/persistence-network.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">143</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Resolve on sandbox targets — no network exists to toggle; writes issued while "disabled" still commit immediately (no offline queue is simulated). Forward to <code>fb.enableNetwork</code> / <code>fb.disableNetwork</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/persistence-network.test.ts</code></div>
<div class="compat-note">no offline queue</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">144</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Resolves immediately on sandbox targets — every accepted write is already committed locally by the time its own promise resolves, so there are never writes still pending a server round-trip. Forwards to <code>fb.waitForPendingWrites</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/persistence-network.test.ts</code></div>
<div class="compat-note">always resolves; prod can hang offline</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">152</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Genuinely tears the target down on sandbox targets — calls <code>Sandbox.dispose()</code>, which tears down listener registries on the sandbox's environment (idempotent, doesn't touch data). This differs from the real SDK in scope: <code>dispose()</code> operates on the whole <code>Sandbox</code>, not a Firestore-only slice, so if <code>pyric/database</code>/<code>pyric/storage</code> share the same <code>Sandbox</code> their listener registries are torn down too. Forwards to <code>fb.terminate</code> on prod targets, which only tears down the one Firestore instance</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/terminate.test.ts</code></div>
<div class="compat-note">tears down the whole Sandbox, not a Firestore-only slice</div></div>
</details>
</div>

## Tier-1 cache-init + get-from-* family

`initializeFirestore`, the six cache-factory tokens
(`persistentLocalCache`, `memoryLocalCache`, `persistentSingleTabManager`,
`persistentMultipleTabManager`, `memoryEagerGarbageCollector`,
`memoryLruGarbageCollector`), `getDocFromServer` / `getDocsFromServer`,
`getDocFromCache` / `getDocsFromCache`, `setLogLevel`, and
`onSnapshotsInSync` are now exported from `pyric/firestore`. Before
this, none of these existed on the modular surface — an app using the
common explicit-init pattern```ts
const db = initializeFirestore(app, {
  localCache: persistentLocalCache(persistentMultipleTabManager()),
});
```crashed at IMPORT (a missing named export) before it ever ran a read
or write.

**Honest-mirror rationale**: these are aliases and honest no-op
config tokens, not new feature work. `initializeFirestore` delegates
to `getFirestore` and returns the same handle; it accepts the
`settings` argument but no-ops the cache/network settings, because
persistence is already the sandbox default — there is no separate
cache tier to configure into existence. The six cache-factory tokens
return small tagged objects so identity/usage doesn't crash; they are
inert for the same reason. `getDocFromServer` / `getDocFromCache` and
their plural forms delegate to the same read path as `getDoc` /
`getDocs` on sandbox targets — the sandbox store IS the authoritative,
always-fresh source, so there is no cache/server split to honor; on
prod targets they forward to the real split, preserving prod's real
cache-miss-throws behavior. `setLogLevel` is an accepted no-op — the
sandbox has no modular-SDK-style logger to wire a level into.
`onSnapshotsInSync` fires its callback once the current
snapshot-delivery microtask queue settles, the closest honest
approximation of "every listener delivered" available without a true
cross-listener sync signal.

## Tier-1 cache-init + get-from-* family (continued)

<div class="compat-list">
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">145</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Delegates to <code>getFirestore(app)</code> and returns the same handle. Accepts the <code>settings</code> argument (so the explicit-init pattern doesn't crash at import) but no-ops the cache/network settings — persistence is always on. Prod path forwards only to <code>getFirestore(app)</code>; a real settings pass-through for prod is out of scope for this tier-1 pass</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div>
<div class="compat-note">settings accepted but cache/network settings are no-ops</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">146</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Config token accepted, inert — each returns a small tagged object so identity/usage doesn't crash. Persistence is the sandbox default; there is no cache tier left to configure</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div>
<div class="compat-note">inert config tokens; no cache tier to configure</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">147</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Delegates to <code>getDoc</code> / <code>getDocs</code> on sandbox targets — the sandbox store IS the authoritative source, so there is no separate server round-trip to force and no observable divergence from the default read. Forwards to <code>fb.getDocFromServer</code> / <code>fb.getDocsFromServer</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">148</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Delegates to <code>getDoc</code> / <code>getDocs</code> on sandbox targets. Real Firebase THROWS <code>'unavailable'</code> here on a genuine cache miss; pyric never misses — the local store always has the answer (or a non-existent snapshot) — so it never throws for that reason. Forwards to <code>fb.getDocFromCache</code> / <code>fb.getDocsFromCache</code> on prod targets, which DO throw on a real cache miss</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div>
<div class="compat-note">never throws unavailable; sandbox has no cache miss</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">149</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Accepted no-op — the sandbox has no modular-SDK-style logger to wire a level into; it uses host-level <code>console</code> logging directly, gated by <code>pyric dev</code>'s own flags, not this call</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div>
<div class="compat-note">accepted no-op; no sandbox logger wired</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">150</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Fires the callback once the current snapshot-delivery microtask queue settles — the closest honest approximation of "every active listener has delivered its latest state" available without a true cross-listener sync signal. Not scoped to real server round-trips like the real SDK's guarantee; scoped to local delivery only. Forwards to <code>fb.onSnapshotsInSync</code> on prod targets</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/tier1-cache-init-align.test.ts</code></div>
<div class="compat-note">approximated from local snapshot-delivery settle, not a true global in-sync signal</div></div>
</details>
</div>

## `sandbox.*` — sandbox-only ops

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">122</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.setRules(db, rules)</code> loads rules into the underlying <code>LocalEnvironment</code>; returns <code>LintResult</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code>, <code>playground:rules-data-validation</code>, <code>playground:rules-cross-doc-get</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">123</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.seedDocuments(db, {path: data, ...})</code> bulk-loads bypassing rules</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">124</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sandbox.snapshotState(db)</code> dumps every document the LocalEnvironment has stored</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">125</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">All <code>sandbox.*</code> methods throw <code>SandboxError('failed-precondition')</code> on prod-target handles</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-target.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">126</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">All <code>sandbox.*</code> methods work on a sandbox-live handle (route through <code>sandboxDb</code>)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("sandboxOps.setRules + seedDocuments + snapshotState work on a live handle")</div></div>
</details>
</div>

## Rules engine (via `sandbox.setRules`)

Rules-engine behavior is technically `pyric-admin`'s `LocalEnvironment`,
but it's the most-tested surface for divergence — `request.auth`,
cross-doc reads via `get()`, data validation. These rows pin the
shape consumer code depends on.

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">127</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>request.auth.uid</code> reads through to <code>sandbox.currentUser?.uid</code> on sandbox-live</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:auth-anonymous</code>, <code>playground:rules-cross-doc-get</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">128</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>request.auth == null</code> when sandbox.currentUser is null (anonymous path)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:sandbox-live-identity.test.ts</code> ("anonymous fallback")</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">129</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Cross-doc <code>get(/databases/$(database)/documents/...)</code> in rules works under sandbox; <code>get()</code> of a <strong>missing</strong> doc ERRORS (guard with <code>exists()</code>), and <code>get(p).id</code> / <code>get(p).__name__</code> expose the doc identity (RULES-B8)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:rules-cross-doc-get</code>, <code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B8 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">130</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>request.resource.data.&lt;field&gt;</code> field validation in rules works under sandbox; an <strong>undefined</strong> field read ERRORS (deny), it does NOT read as null (RULES-B2) — guard with <code>'f' in data</code> / <code>data.get('f', d)</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:rules-data-validation</code>, <code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B2 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">131</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>resource.data.&lt;field&gt;</code> (existing doc on writes) works under sandbox; undefined-field reads ERROR (RULES-B2)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:rules-resource-data-field</code>, <code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B2 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">132</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Custom claims in <code>request.auth.token.&lt;claim&gt;</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>playground:rules-custom-claims</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">133</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Tri-state error semantics: DOTTED field access of a missing key (<code>resource.data.typo</code>), access on null/undefined, undefined variables, and <code>get()</code>-of-missing ERROR → deny; <code>&amp;&amp;</code>/<code>||</code> absorb operand errors <strong>commutatively</strong> (CEL: <code>error || true</code> → true, <code>error &amp;&amp; false</code> → false). NOTE: DYNAMIC index access <code>data[expr]</code> stays null-on-miss (the documented may-be-absent-lookup idiom; only dotted access is doc-confirmed to error). (RULES-B2/B3/B8)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B2 / RULES-B3 / RULES-B8 blocks)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">134</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>matches()</code> is a <strong>full-string</strong> anchored RE2 test; <code>replace()</code>/<code>split()</code> take regexes (<code>replace</code> = all occurrences) (RULES-B4)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B4 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">135</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">No JS prototype-chain leakage: <code>'toString' in data</code> → false, <code>data.constructor</code> errors; <code>in</code>/<code>hasAll</code>/<code>get</code> use own keys only (RULES-B7)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B7 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">136</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Type-strict operators: <code>+</code> requires matching operand types (<code>'a' + 1</code> errors; <code>[1]+[2]</code> concatenates); ordered compares (<code>&lt; &gt; &lt;= &gt;=</code>) error across types; list membership uses value equality; <code>is map</code> excludes MapDiff/Set (RULES-B6 partial / B9 / B12 partial)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B6 / B9 / B12 blocks)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">136b</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>FirestoreSet</code> VALUE equality: <code>diff.addedKeys() == [uid].toSet()</code> compares set contents (order-insensitive); <code>set == list</code> is false, not an error (RULES-B13). Pre-fix, ANY two sets compared EQUAL (generic-object deep-equals saw no enumerable keys) — a false-PERMISSIVE divergence found by joining validation</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/set-equality.test.ts</code>; live validation: 10/10 both engines</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">137</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>update</code> exposes <code>request.resource.data</code> / <code>getAfter()</code> as the existing doc <strong>merged</strong> with the payload via the <code>writeMode: { kind: 'update' }</code> path (the agent-facing <code>simulate()</code> opt-in); a sparse no-writeMode payload that drops a field now ERRORS on that field (RULES-B2) rather than silently reading null (RULES-B10)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/handler.test.ts</code> (RULES-B10 block)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">138</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Int/float distinction (<code>1.5 is int</code>→false, <code>1 is float</code>→false, <code>1.0 is float</code>→true) + integer division (<code>10 / 4 == 2</code>) + int div/mod-by-zero ERRORS (RULES-B5); strict <code>int('12abc')</code>/<code>float('abc')</code>/<code>bool('false')</code>/<code>bool('yes')</code> parsing (RULES-B6 rest); <code>string(1.0)</code>→"1.0" (RULES-B12 rest)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/evaluator.test.ts</code> (RULES-B5 + "RULES-B6 remainder" blocks); <code>unit:rules/simulator/handler.test.ts</code> ("RULES-B5 end-to-end" block)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">138a</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">DEFERRED sub-items of row 138: strict bool in <code>&amp;&amp;</code>/<code>||</code>/ternary (<code>1 &amp;&amp; true</code> should error) — corpus-coupled, needs emulator; a FLOAT stored in JSON test-data reads as int (<code>data.x is float</code>→false; prod uses the stored Firestore type tag) — needs a <code>__type:'float'</code> test-data revive marker; <code>resource</code>-null-on-create (RULES-B12 rest)</span></summary>
<div class="compat-evidence"><div class="compat-probe">DEFERRED — see the design rationale (limitation + sub-items); strict-bool also in <code>step-07</code>.</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">139</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Query-proof EVALUATION — the rules-side decision ("rules are not filters"): given a <code>list</code> rule + query constraints, decide provable-or-reject (a doc-dependent rule like <code>resource.data.visibility == 'public'</code> is provable ONLY with a matching <code>where('visibility','==','public')</code>; otherwise the whole query is rejected) (RULES-B11 rules-side)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:rules/simulator/query-proof.test.ts</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">139a</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Query-proof ENFORCEMENT wiring — <code>silentReadCollection</code> + <code>readQueryCandidates</code> call <code>evaluateQueryProof</code> (via <code>sandbox/firestore/list-query-proof.ts</code>) instead of the per-doc silent-omission filter; structured <code>where</code>/<code>limit</code>/<code>orderBy</code> constraints are threaded from <code>QueryImpl.structuredConstraints()</code> through both the one-shot (<code>getDocs</code>/aggregate) and listener (<code>SnapshotTarget</code> applier <code>.structured</code>) paths, and <code>request.query.{limit,offset,orderBy}</code> is populated on list test cases (RULES-B11 cross-file)</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:firestore/query-proof-enforcement.test.ts</code> (both paths; verified failing pre-fix); prover scope caveat: row 24c</div></div>
</details>
</div>

## Rules engine — production simulator conformance (rules-firestore corpus)

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

## Deny-list (intentionally NOT shimmed)

These exist in `firebase/firestore` but the sandbox refuses to
import/use them. The agent's writeApp prompt and the deploy
bundle's metafile gate enforce the deny-list at build time.

| Name | Reason |
|---|---|
| `CACHE_SIZE_UNLIMITED` / `PersistentCacheIndexManager` / `getPersistentCacheIndexManager` / `deleteAllPersistentCacheIndexes` / `enablePersistentCacheIndexAutoCreation` / `disablePersistentCacheIndexAutoCreation` / `setIndexConfiguration` | Index-tuning / GC-policy admin surface; no sandbox equivalent knob. Distinct from the tier-1 cache-factory tokens (`persistentLocalCache` / `memoryLocalCache` / tab-managers / GC-collectors) and `getDoc*FromCache` / `getDoc*FromServer` / `setLogLevel` / `onSnapshotsInSync`, which are now mirrored (see the tier-1 cache-init + get-from-* section above tier-1 pass) |
| `terminate` | Out of scope — `Sandbox.dispose()` covers teardown at the host level today |
| `loadBundle` / `namedQuery` | Bundle-loading depends on server-side packaging not modeled in sandbox |

---

## Visible gaps to address next

Rows currently marked **?** (need explicit probes): none — #132
landed with `playground:rules-custom-claims` after the preview-scope
expansion exposed `sandbox.seedUsers` via the `firebase/auth` virtual
re-export.

Rows **locked by the empirical oracle harness** (committed observations under `scripts/oracle/observations/`, captured against the `blockingfun` project):

- #21 rules-denied error class — oracle confirmed prod throws `FirebaseError` with `.code === 'permission-denied'`.
- #39 `deleteDoc` on missing doc — oracle confirmed prod no-ops; sandbox fix landed (see below).
- #45 `addDoc` auto-id format — oracle confirmed prod mints 20-char alphanumeric (mixed upper/lower/digits, no other chars).
- #79 aggregate cost / shape — oracle confirmed `data()` returns `{ count: number }` only; empty query returns `count: 0`.
- #85 `includeMetadataChanges` — oracle confirmed prod fires +1 extra time per write (the server-confirmed transition); default listener fires twice for one write (initial + pending).
- #109 `Bytes` round-trip — oracle confirmed prod `setDoc`+`getDoc` round-trips as a `Bytes` instance with the same base64; sandbox now matches via the converter + read finalization (see row).
- #110 `GeoPoint` round-trip — oracle confirmed prod `setDoc`+`getDoc` round-trips as a `GeoPoint` instance with the same lat/lng; sandbox now matches via the converter + read finalization (see row).
- #116 `queryEqual` semantics — oracle confirmed structural in prod.
- #117 `snapshotEqual` semantics — oracle showed identity-only in prod; row corrected from ⚠ to ✓.

Rows currently marked **⚠** that we might want to upgrade to **✓**
(by aligning the sandbox to prod or by formally documenting the
divergence in `feature-matrix.md`):

- #21 rules-denied error class (`SandboxError` vs `FirebaseError`)
- #45 auto-id format
- #66 index validation parity (sandbox would benefit from a strict mode that errors when no index would exist in prod)
- #79 aggregate cost model
- #85 `includeMetadataChanges`
- #93 transaction retry / contention model
- #116 `queryEqual` structural equality (sandbox identity-only; prod structural per oracle)

Rows currently marked **—** that we might want to fill (rough priority):

1. Admin/server vector surface: `FieldValue.vector()` write + `findNearest`
   search live on `firebase-admin` / `pyric-admin`, NOT this client matrix (the
   web client SDK has neither). The client value type (row #111) now conforms; the
   admin surface has no COMPAT matrix yet, and vector search is staged for Phase
   5b. See the design rationale.

## Probe coverage summary

- **Unit (`packages/pyric/test/firestore/`):** ~80 tests across 4 files cover the bulk of the surface. The two main files are `sandbox-target.test.ts` (frozen-ctx, the API-shape conformance suite) and `sandbox-live-identity.test.ts` (per-op identity behavior). `prod-target.test.ts` runs against an emulator; `prod-integration.test.ts` requires a real project (gated).
- **Playground fixtures (`packages/playground/scripts/fixtures/`):** 8 firestore-related fixtures: `firestore-bare-getfirestore`, `firestore-onsnapshot`, `firestore-query`, `firestore-transaction`, `firestore-batch`, `firestore-sentinels`, `rules-cross-doc-get`, `rules-data-validation`. Run via `bun run debug:fixtures`.

## Next refactors per the methodology

Per the design rationale's "What's next" section:

1. **Probe-per-matrix-row.** Today's fixtures + unit tests cover 3-5 behaviors each. Splitting into one probe per row makes failures point at exactly one violation. The current bundled probes stay as integration tests; the new probe-per-row set becomes the conformance gate.
2. **Empirical oracle harness.** Several rows marked **?** are ambiguous from docs alone. The harness at `scripts/oracle/run.ts` runs the probes against a real Firebase project and writes observations to `scripts/oracle/observations/<name>.json`. Initial coverage locks #39, #116, #117 (above). Extend with additional probes for the remaining `?` and `⚠` rows.
3. **CI gate.** `bun run debug:fixtures` becomes a required check on every PR that touches `packages/firestore`.
