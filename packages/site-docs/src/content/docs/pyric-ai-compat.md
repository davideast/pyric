---
title: "pyric/ai compatibility matrix"
navLabel: "AI Logic"
group: "Compatibility"
section: ""
order: 8008
---
<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/ai` compatibility matrix

This surface climbed under Conformance Driven Development
(map: https://github.com/davideast/pyric/issues/92). Every row below was
born `unverified` at admission: the row universe and the red conformance
suites came first, the mirror implementation came after. All 78 rows are
now flipped: the climb lane (`bun run compat:climb-ai`, the suites at
`packages/pyric/test/ai`) passes 78 of 78 with no assertion
weakened, and every row records the tier of evidence that vouches for it.

Evidence tiers per `packages/conformance/docs/ai/cdd-deltas.md`:

- `oracle-backed` (10 rows): the suite replays value-deterministic facts
  from a cited observation (error envelopes, countTokens, byte-compared
  stream framing, the thought-signature rejection).
- `shape-backed` (23 rows): the suite replays an observation's distilled
  shape facts (key sets, enum values, streaming semantics); values are
  nondeterministic in production.
- `unit-backed` (28 rows): SDK mechanics with no vouching observation
  (dispatch, ChatSession behavior, Schema builders, response helpers).
- `sandbox-only` (17 rows): the answer-engine seam, which has no
  production analogue.

72 rows conform; 6 are documented divergences from the installed
firebase/ai 2.12.0, each with the reason pinned in its notes.

Generated-content VALUES are never claims. Production output is
nondeterministic, so no row asserts on generated text, and the suites only
compare text when the scripted engine was explicitly scripted to return it
(the shape-backed tier ruling in `packages/conformance/docs/ai/cdd-deltas.md`).

## Status legend

<div class="compat-key">
<span class="compat-key-item"><span class="compat-dot" data-status="ok"></span><strong>Conforming</strong>: sandbox matches prod, locked by a passing probe</span>
<span class="compat-key-item"><span class="compat-dot" data-status="diverged"></span><strong>Diverged (documented)</strong>: intentional difference with a written reason</span>
<span class="compat-key-item"><span class="compat-dot" data-status="bug"></span><strong>Bug</strong>: should match prod but doesn't; failing probe pins it</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unsupported"></span><strong>Unsupported</strong>: not implemented yet (deliberately or pending)</span>
<span class="compat-key-item"><span class="compat-dot" data-status="unverified"></span><strong>Unverified</strong>: claim not yet locked by a passing probe</span>
</div>

Probe references: `unit:<file>` means a passing Bun test in
`packages/pyric/test/ai/<file>` (the climb lane). Captures live at
`packages/conformance/observations/ai/ai-*.json`; a row that cites one replays the
capture's distilled facts in the named test.

---

## `getAI(target)` and dispatch

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-sandbox-dispatch</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getAI(sandbox)</code> returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-sandbox-dispatch</code> (no capture; structural dispatch claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-app-dispatch</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">After package resolution selects the mirror, <code>getAI(app)</code> uses the app's sandbox and the returned handle carries the app</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-app-dispatch</code> (package-resolution dispatch claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-default-backend</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">With no options the backend defaults to <code>GoogleAIBackend</code>, <code>backendType</code> is <code>GOOGLE_AI</code>, and the AI handle location is the empty string</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-default-backend</code> (matches upstream AIOptions default)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-idempotent</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Repeat <code>getAI</code> calls with the same target return a stable handle</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-idempotent</code> (no capture; structural claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-engine-option</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })</code> selects the scripted engine explicitly and behaves identically to the zero-config default</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-engine-option</code> (engine seam per packages/conformance/docs/ai/cdd-deltas.md)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">backend-vertex</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>VertexAIBackend</code> carries <code>backendType</code> <code>VERTEX_AI</code>; its location and the resulting AI handle location default to <code>us-central1</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#backend-vertex</code> (matches upstream constructor default)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">model-name-short</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A short model name such as <code>gemini-flash-lite-latest</code> normalizes to the <code>models/</code> resource name on <code>GenerativeModel.model</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#model-name-short</code> (upstream AIModel normalization on the GoogleAI backend)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">model-name-prefixed</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">A <code>models/</code>-prefixed name is accepted without double prefixing</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#model-name-prefixed</code> (no capture; normalization claim)</div>
<div class="compat-note">normalization</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">model-name-required</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>getGenerativeModel</code> without <code>modelParams.model</code> throws an <code>AIError</code> with code <code>no-model</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#model-name-required</code> (upstream throw contract)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">getai-sandbox-no-network</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The sandbox target with the scripted engine performs no network I/O for generateContent</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:instances.test.ts</code> test <code>ai#getai-sandbox-no-network</code> (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere)</div></div>
</details>
</div>

## `GenerativeModel.generateContent` envelope

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-envelope-keys</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The response envelope top-level key set is exactly <code>candidates</code>, <code>modelVersion</code>, <code>responseId</code>, <code>usageMetadata</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-envelope-keys</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-candidate-keys</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The candidate key set is <code>content</code>, <code>finishReason</code>, <code>index</code>, and <code>index</code> is present on the wire (0 for the single candidate)</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope (candidateHasIndexOnWire) replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-candidate-keys</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-role-model</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Candidate content carries role <code>model</code> and the content key set is <code>parts</code>, <code>role</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-role-model</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-finish-stop</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A normal completion finishes with <code>finishReason</code> <code>STOP</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-finish-stop</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-usage-key-set</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The usageMetadata key set on a minimal text call is <code>candidatesTokenCount</code>, <code>promptTokenCount</code>, <code>promptTokensDetails</code>, <code>serviceTier</code>, <code>totalTokenCount</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-usage-key-set</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-usage-service-tier</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>usageMetadata.serviceTier</code> rides the wire even though the 2.12.0 SDK typings do not declare it</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope (usageServiceTierPresent) replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-usage-service-tier</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-modelversion-responseid</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>modelVersion</code> and <code>responseId</code> are present nonempty strings; the sandbox mints them deterministically</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-modelversion-responseid</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-string-request</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A plain string request is wrapped as a single user turn before it reaches the engine</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:generate-content.test.ts</code> test <code>ai#generate-string-request</code> (no capture; upstream request formatting claim)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-system-instruction</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A top-level <code>systemInstruction</code> is accepted and the response envelope shape is unaffected</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-system-instruction-accepted replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-system-instruction</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-structured-output</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>responseMimeType</code> <code>application/json</code> plus a <code>responseSchema</code> yields a text part that parses as JSON with the schema key set</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-structured-output-shape replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-structured-output</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-thinking-signature</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">With <code>thinkingConfig</code> on the probe model, text parts carry <code>thoughtSignature</code> and no part is flagged <code>thought: true</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-thinking-thought-parts (partKeySets, anyThoughtPart false) replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-thinking-signature</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-abort-signal</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A pre-aborted <code>SingleRequestOptions.signal</code> rejects the call</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:generate-content.test.ts</code> test <code>ai#generate-abort-signal</code> (no capture; upstream SingleRequestOptions contract)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">generate-decoration-synthesized</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Token counts are minted without a tokenizer, and the minimal envelope omits <code>safetyRatings</code>, matching the captured candidate key set</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test <code>ai#generate-decoration-synthesized</code></div></div>
</details>
</div>

## `generateContentStream` framing and aggregation

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-async-iterable</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>result.stream</code> async-iterates response chunks via <code>for await</code>; each chunk is a complete GenerateContentResponse</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing replayed by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-async-iterable</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-data-prefixed</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Every SSE event is <code>data: </code> prefixed and its payload parses as a complete JSON document</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing (allEventsDataPrefixed) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-data-prefixed</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-separator-crlf</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">SSE events are separated by CRLF CRLF</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing (separatorIsCrlfCrlf) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-separator-crlf</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-finish-last-chunk</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>finishReason</code> appears only on the last chunk of a stream</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing (finishReasonOnlyOnLastChunk) replayed by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-finish-last-chunk</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-usage-every-chunk</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>usageMetadata</code> rides every chunk, not only the last one</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing (usageMetadataChunkIndexes covers all chunks) replayed by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-usage-every-chunk</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-chunk-envelope</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Every chunk carries <code>candidates</code> or <code>usageMetadata</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-stream-framing (everyEventHasCandidatesOrUsage) replayed by packages/pyric/test/ai/streaming.test.ts test <code>ai#stream-chunk-envelope</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">stream-response-aggregate</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>result.response</code> resolves to an aggregated response whose text is the concatenation of the streamed text parts</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:streaming.test.ts</code> test <code>ai#stream-response-aggregate</code> (aggregation semantics; text values come from an explicit script)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">stream-aggregate-final-meta</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">The aggregated response carries the final chunk <code>finishReason</code> and <code>usageMetadata</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:streaming.test.ts</code> test <code>ai#stream-aggregate-final-meta</code> (aggregation semantics derived from the framing capture)</div>
<div class="compat-note">metadata carry</div></div>
</details>
</div>

## `ChatSession` history and streaming turns

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">chat-startchat</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>startChat</code> returns a <code>ChatSession</code> seeded with <code>StartChatParams.history</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-startchat</code> (no capture; structural claim)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">chat-history-threads</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>sendMessage</code> appends the user turn and the model turn; <code>getHistory()</code> returns the ordered <code>Content[]</code> with alternating roles</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-history-threads</code> (no capture; history threading claim)</div>
<div class="compat-note">clone</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">chat-history-excludes-blocked</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Blocked prompts and blocked candidates are excluded from <code>getHistory()</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-history-excludes-blocked</code> (upstream JSDoc contract; exercised with a scripted blocked envelope)</div>
<div class="compat-note">blocked history</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">chat-sendmessage-envelope</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A <code>sendMessage</code> result carries the same envelope facts as <code>generateContent</code>: the four top-level keys and role <code>model</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/chat-session.test.ts test <code>ai#chat-sendmessage-envelope</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">chat-sendmessagestream</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>sendMessageStream</code> returns a stream plus a response promise; history updates after aggregation completes</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-sendmessagestream</code> (no capture; streaming turn claim)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">chat-stream-single-user-turn</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior">Exactly one user turn is recorded per <code>sendMessageStream</code> call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-stream-single-user-turn</code> (no capture; divergence pinned by ruling, see notes)</div>
<div class="compat-note">2.13.0 semantics</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">chat-role-vocabulary</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>POSSIBLE_ROLES</code> is exactly <code>["user", "model", "function", "system"]</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:chat-session.test.ts</code> test <code>ai#chat-role-vocabulary</code> (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role)</div></div>
</details>
</div>

## Function calling

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-part-shape</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A functionCall part carries the key set <code>args</code>, <code>id</code>, <code>name</code>, and <code>args</code> arrives as a parsed JSON object, not a string</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-function-call-shape (functionCallKeySet, argsIsObjectNotString) replayed by packages/pyric/test/ai/function-calling.test.ts test <code>ai#fncall-part-shape</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-mode-any</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Mode <code>ANY</code> forces a functionCall part in the response and the candidate finishes <code>STOP</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-function-call-shape (captured under mode ANY, finishReason STOP) replayed by packages/pyric/test/ai/function-calling.test.ts test <code>ai#fncall-mode-any</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-id-present</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>functionCall.id</code> is present on the GoogleAI wire; the mirror emits an id on synthesized calls</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-function-call-shape (id in functionCallKeySet) replayed by packages/pyric/test/ai/function-calling.test.ts test <code>ai#fncall-id-present</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-round-trip</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-function-response-round replayed by packages/pyric/test/ai/function-calling.test.ts test <code>ai#fncall-round-trip</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-thought-signature-required</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A replayed model functionCall turn lacking <code>thoughtSignature</code> is rejected 400 INVALID_ARGUMENT with the thought-signature message</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-fncall-missing-thought-signature replayed by packages/pyric/test/ai/function-calling.test.ts test <code>ai#fncall-thought-signature-required</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">fncall-signature-minted</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The engine mints a <code>thoughtSignature</code> on every functionCall part it synthesizes, so scripted tool round trips replay cleanly</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:function-calling.test.ts</code> test <code>ai#fncall-signature-minted</code> (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)</div></div>
</details>
</div>

## `countTokens`

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">counttokens-envelope</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The countTokens envelope key set is exactly <code>promptTokensDetails</code>, <code>totalTokens</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-counttokens-envelope replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#counttokens-envelope</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">counttokens-deterministic</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">An identical payload returns an identical <code>totalTokens</code> across calls</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-counttokens-envelope (deterministicAcrossTwoCalls) replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#counttokens-deterministic</code></div></div>
</details>
</div>

## Error envelopes

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-unknown-model</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A model name production has never served fails 404 NOT_FOUND with the error key set <code>code</code>, <code>message</code>, <code>status</code> and no details</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-unknown-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#error-unknown-model</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-retired-model</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-retired-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#error-retired-model</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-bad-api-key</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message <code>API key not valid. Please pass a valid API key.</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-bad-api-key replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#error-bad-api-key</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-empty-contents</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">An empty <code>contents</code> array fails 400 INVALID_ARGUMENT with the message <code>contents is not specified</code></span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-empty-contents replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#error-empty-contents</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-bad-role</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-error-bad-role replayed by packages/pyric/test/ai/errors-counttokens.test.ts test <code>ai#error-bad-role</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-aierror-shape</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">HTTP failures surface as <code>AIError</code> with an <code>AIErrorCode</code> code and <code>customErrorData</code> carrying <code>status</code>, <code>statusText</code>, and <code>errorDetails</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:errors-counttokens.test.ts</code> test <code>ai#error-aierror-shape</code> (capture ai-error-bad-api-key cited as the sample envelope)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">error-code-vocabulary</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>AIErrorCode</code> exposes the 14 documented codes, from <code>error</code> through <code>unsupported</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:errors-counttokens.test.ts</code> test <code>ai#error-code-vocabulary</code> (upstream constant vocabulary)</div></div>
</details>
</div>

## Response helpers (`EnhancedGenerateContentResponse`)

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-text</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>text()</code> concatenates the text parts of the first candidate</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#helper-text</code> (text value asserted only because the scripted engine was scripted to return it)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-text-throws</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>text()</code> throws on bad finish reasons such as <code>SAFETY</code> and on a blocked prompt</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#helper-text-throws</code> (exercised with a scripted SAFETY envelope)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-functioncalls</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>functionCalls()</code> returns the <code>FunctionCall</code> array from the functionCall parts, args as parsed objects</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-function-call-shape replayed by packages/pyric/test/ai/helpers-schema.test.ts test <code>ai#helper-functioncalls</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-thoughtsummary</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>thoughtSummary()</code> returns undefined when no part is flagged <code>thought: true</code>, the captured lite-model case</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-thinking-thought-parts (anyThoughtPart false) replayed by packages/pyric/test/ai/helpers-schema.test.ts test <code>ai#helper-thoughtsummary</code></div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-inlinedataparts</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>inlineDataParts()</code> returns the <code>InlineDataPart</code> array when inlineData parts exist and undefined when none do</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#helper-inlinedataparts</code> (exercised with a scripted raw envelope)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">helper-tolerates-missing-decor</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Helpers tolerate omitted decoration: an envelope without <code>usageMetadata</code>, <code>finishReason</code>, or <code>safetyRatings</code> still serves <code>text()</code> without throwing</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#helper-tolerates-missing-decor</code> (exercised with a scripted bare envelope)</div></div>
</details>
</div>

## `Schema` builders

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">schema-object-tojson</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Schema.object</code> serializes to type <code>object</code> with <code>properties</code>, and <code>required</code> is derived by excluding <code>optionalProperties</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#schema-object-tojson</code> (upstream toJSON request shape)</div></div>
</details>
<details class="compat-row" data-status="diverged">
<summary class="compat-line"><span class="compat-num">schema-string-enum</span><span class="compat-dot" data-status="diverged" role="img" aria-label="Diverged (documented)" title="Diverged (documented)"></span><span class="compat-behavior"><code>Schema.enumString</code> serializes the enum values with type <code>string</code> and format <code>enum</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#schema-string-enum</code> (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats)</div>
<div class="compat-note">format</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">schema-primitives</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Each primitive builder serializes its <code>SchemaType</code>, and <code>array</code> carries <code>items</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#schema-primitives</code> (upstream toJSON request shape)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">schema-anyof</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior"><code>Schema.anyOf</code> returns an <code>AnyOfSchema</code> whose JSON carries an <code>anyOf</code> array of sub-schemas and no top-level type</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:helpers-schema.test.ts</code> test <code>ai#schema-anyof</code> (upstream toJSON request shape)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">schema-rides-request</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A built <code>Schema</code> serializes into <code>generationConfig.responseSchema</code> on the request and drives JSON output</span></summary>
<div class="compat-evidence"><div class="compat-probe">Capture ai-structured-output-shape replayed by packages/pyric/test/ai/helpers-schema.test.ts test <code>ai#schema-rides-request</code></div></div>
</details>
</div>

## Sandbox answer engine: scripted

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-zero-config</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-zero-config</code> (capture ai-generate-minimal-envelope cited as the shape source)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-deterministic</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The same unscripted request twice yields an identical envelope, candidates and usage included</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-deterministic</code> (determinism claim from the scripted authoring deltas)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-queue-order</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Script entries without matchers are consumed in FIFO queue order</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-queue-order</code> (ruling 2 of the scripted authoring deltas)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-matchers</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-matchers</code> (ruling 2 of the scripted authoring deltas)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-raw-envelope</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A raw Gemini envelope entry is returned verbatim, so an observation <code>behavior.raw</code> pastes in directly and captures are the corpus</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-raw-envelope</code> (ruling 3 of the scripted authoring deltas)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-shorthand-text</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A <code>text</code> shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-shorthand-text</code> (capture ai-generate-minimal-envelope cited as the expansion target)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-shorthand-functioncall</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A <code>functionCall</code> shorthand expands to a model turn whose functionCall part carries a minted <code>thoughtSignature</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-shorthand-functioncall</code> (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-stream-chunks</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-stream-chunks</code> (capture ai-generate-stream-framing cited as the framing source)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">scripted-text-assertable</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Scripted text is the one place generated text values may be asserted: <code>response.text()</code> returns the scripted string exactly</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#scripted-text-assertable</code> (evidence tier ruling 1: generated text is never compared anywhere else)</div></div>
</details>
</div>

## Sandbox answer engine: openai translation

<div class="compat-list">
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">openai-request-translation</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Gemini <code>contents</code> and <code>systemInstruction</code> translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role <code>model</code></span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#openai-request-translation</code> (translation exercised against a local OpenAI-compatible mock)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">openai-fifo-tool-ids</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">OpenAI <code>tool_call</code> ids are matched FIFO against Gemini functionResponse parts when replaying tool history</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#openai-fifo-tool-ids</code> (lossy translation edge from ticket #96)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">openai-buffered-fncalls</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#openai-buffered-fncalls</code> (lossy translation edge from ticket #96)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">openai-done-not-forwarded</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">The OpenAI <code>[DONE]</code> sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#openai-done-not-forwarded</code> (lossy translation edge from ticket #96)</div></div>
</details>
<details class="compat-row" data-status="ok">
<summary class="compat-line"><span class="compat-num">openai-thought-parts-skipped</span><span class="compat-dot" data-status="ok" role="img" aria-label="Conforming" title="Conforming"></span><span class="compat-behavior">Parts flagged <code>thought: true</code> in history are skipped when replaying to an OpenAI upstream</span></summary>
<div class="compat-evidence"><div class="compat-probe"><code>unit:engines.test.ts</code> test <code>ai#openai-thought-parts-skipped</code> (lossy translation edge from ticket #96)</div></div>
</details>
</div>
