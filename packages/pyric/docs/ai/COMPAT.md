<!-- Generated from packages/conformance/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/ai` compatibility matrix

<div class="compat-stat">
<p class="compat-stat-surface"><strong>Public surface:</strong> runtime 69.1% (38/55) <span aria-hidden="true">·</span> types 66.5% (109/164)</p>
<p class="compat-stat-figure">
<span class="compat-stat-pct">92.3%</span>
<span class="compat-stat-label">of tracked behaviors conform</span>
</p>
<p class="compat-stat-denom">72 of 78 tracked behaviors</p>
<div class="compat-stat-bar" role="img" aria-label="Behavior distribution: 72 conform, 6 documented divergences, 0 bugs, 0 unsupported, 0 unverified.">
<span class="compat-stat-seg" data-status="ok" style="flex-grow: 72" aria-hidden="true"></span>
<span class="compat-stat-seg" data-status="diverged" style="flex-grow: 6" aria-hidden="true"></span>
</div>
<ul class="compat-stat-key" aria-label="Behavior state counts">
<li class="compat-stat-item"><span class="compat-dot" data-status="ok" aria-hidden="true"></span><span><strong>72</strong> conform</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="diverged" aria-hidden="true"></span><span><strong>6</strong> documented divergences</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="bug" aria-hidden="true"></span><span><strong>0</strong> bugs</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unsupported" aria-hidden="true"></span><span><strong>0</strong> unsupported</span></li>
<li class="compat-stat-item"><span class="compat-dot" data-status="unverified" aria-hidden="true"></span><span><strong>0</strong> unverified</span></li>
</ul>
<p class="compat-stat-note">Public surface measures whether exports exist. Fidelity measures whether tracked behavior matches production.</p>
</div>
[Read how the axes differ.](../conformance/SCORES.md)

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

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match prod but doesn't; failing probe pins it |
| — | **Unsupported**: not implemented yet (deliberately or pending) |
| ? | **Unverified**: claim not yet locked by a passing probe |

Probe references: `unit:<file>` means a passing Bun test in
`packages/pyric/test/ai/<file>` (the climb lane). Captures live at
`packages/conformance/observations/ai/ai-*.json`; a row that cites one replays the
capture's distilled facts in the named test.

---

## `getAI(target)` and dispatch

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| getAI(target) |  | `getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine | ✓ | `unit:instances.test.ts` test `ai#getai-sandbox-dispatch` (no capture; structural dispatch claim) | getai-sandbox-dispatch |
| getAI(target) |  | After package resolution selects the mirror, `getAI(app)` uses the app's sandbox and the returned handle carries the app | ✓ | `unit:instances.test.ts` test `ai#getai-app-dispatch` (package-resolution dispatch claim) | getai-app-dispatch |
| getAI(target) |  | With no options the backend defaults to `GoogleAIBackend`, `backendType` is `GOOGLE_AI`, and the AI handle location is the empty string | ✓ | `unit:instances.test.ts` test `ai#getai-default-backend` (matches upstream AIOptions default) | getai-default-backend |
| getAI(target) |  | Repeat `getAI` calls with the same target return a stable handle | ✓ | `unit:instances.test.ts` test `ai#getai-idempotent` (no capture; structural claim) | getai-idempotent |
| getAI(target, options) |  | `getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })` selects the scripted engine explicitly and behaves identically to the zero-config default | ✓ | `unit:instances.test.ts` test `ai#getai-engine-option` (engine seam per packages/conformance/docs/ai/cdd-deltas.md) | getai-engine-option |
| VertexAIBackend |  | `VertexAIBackend` carries `backendType` `VERTEX_AI`; its location and the resulting AI handle location default to `us-central1` | ✓ | `unit:instances.test.ts` test `ai#backend-vertex` (matches upstream constructor default) | backend-vertex |
| getGenerativeModel(ai, modelParams) |  | A short model name such as `gemini-flash-lite-latest` normalizes to the `models/` resource name on `GenerativeModel.model` | ✓ | `unit:instances.test.ts` test `ai#model-name-short` (upstream AIModel normalization on the GoogleAI backend) | model-name-short |
| getGenerativeModel(ai, modelParams) |  | A `models/`-prefixed name is accepted without double prefixing | ⚠ normalization | `unit:instances.test.ts` test `ai#model-name-prefixed` (no capture; normalization claim) | model-name-prefixed |
| getGenerativeModel(ai, modelParams) |  | `getGenerativeModel` without `modelParams.model` throws an `AIError` with code `no-model` | ✓ | `unit:instances.test.ts` test `ai#model-name-required` (upstream throw contract) | model-name-required |
| getAI(sandbox) |  | The sandbox target with the scripted engine performs no network I/O for generateContent | ✓ | `unit:instances.test.ts` test `ai#getai-sandbox-no-network` (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere) | getai-sandbox-no-network |

## `GenerativeModel.generateContent` envelope

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| generateContent() |  | The response envelope top-level key set is exactly `candidates`, `modelVersion`, `responseId`, `usageMetadata` | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-envelope-keys` | generate-envelope-keys |
| generateContent() |  | The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate) | ✓ | Capture ai-generate-minimal-envelope (candidateHasIndexOnWire) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-candidate-keys` | generate-candidate-keys |
| generateContent() |  | Candidate content carries role `model` and the content key set is `parts`, `role` | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-role-model` | generate-role-model |
| generateContent() |  | A normal completion finishes with `finishReason` `STOP` | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-finish-stop` | generate-finish-stop |
| generateContent() |  | The usageMetadata key set on a minimal text call is `candidatesTokenCount`, `promptTokenCount`, `promptTokensDetails`, `serviceTier`, `totalTokenCount` | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-key-set` | generate-usage-key-set |
| generateContent() |  | `usageMetadata.serviceTier` rides the wire even though the 2.12.0 SDK typings do not declare it | ✓ | Capture ai-generate-minimal-envelope (usageServiceTierPresent) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-service-tier` | generate-usage-service-tier |
| generateContent() |  | `modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-modelversion-responseid` | generate-modelversion-responseid |
| generateContent(request) |  | A plain string request is wrapped as a single user turn before it reaches the engine | ✓ | `unit:generate-content.test.ts` test `ai#generate-string-request` (no capture; upstream request formatting claim) | generate-string-request |
| generateContent(request) |  | A top-level `systemInstruction` is accepted and the response envelope shape is unaffected | ✓ | Capture ai-system-instruction-accepted replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-system-instruction` | generate-system-instruction |
| generateContent(request) |  | `responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set | ✓ | Capture ai-structured-output-shape replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-structured-output` | generate-structured-output |
| generateContent(request) |  | With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true` | ✓ | Capture ai-thinking-thought-parts (partKeySets, anyThoughtPart false) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-thinking-signature` | generate-thinking-signature |
| generateContent(request, singleRequestOptions) |  | A pre-aborted `SingleRequestOptions.signal` rejects the call | ✓ | `unit:generate-content.test.ts` test `ai#generate-abort-signal` (no capture; upstream SingleRequestOptions contract) | generate-abort-signal |
| generateContent() |  | Token counts are minted without a tokenizer, and the minimal envelope omits `safetyRatings`, matching the captured candidate key set | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-decoration-synthesized` | generate-decoration-synthesized |

## `generateContentStream` framing and aggregation

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| generateContentStream() |  | `result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse | ✓ | Capture ai-generate-stream-framing replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-async-iterable` | stream-async-iterable |
| generateContentStream() wire framing |  | Every SSE event is `data: ` prefixed and its payload parses as a complete JSON document | ✓ | Capture ai-generate-stream-framing (allEventsDataPrefixed) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-data-prefixed` | stream-data-prefixed |
| generateContentStream() wire framing |  | SSE events are separated by CRLF CRLF | ✓ | Capture ai-generate-stream-framing (separatorIsCrlfCrlf) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-separator-crlf` | stream-separator-crlf |
| generateContentStream() |  | `finishReason` appears only on the last chunk of a stream | ✓ | Capture ai-generate-stream-framing (finishReasonOnlyOnLastChunk) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-finish-last-chunk` | stream-finish-last-chunk |
| generateContentStream() |  | `usageMetadata` rides every chunk, not only the last one | ✓ | Capture ai-generate-stream-framing (usageMetadataChunkIndexes covers all chunks) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-usage-every-chunk` | stream-usage-every-chunk |
| generateContentStream() |  | Every chunk carries `candidates` or `usageMetadata` | ✓ | Capture ai-generate-stream-framing (everyEventHasCandidatesOrUsage) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-chunk-envelope` | stream-chunk-envelope |
| generateContentStream() |  | `result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts | ✓ | `unit:streaming.test.ts` test `ai#stream-response-aggregate` (aggregation semantics; text values come from an explicit script) | stream-response-aggregate |
| generateContentStream() |  | The aggregated response carries the final chunk `finishReason` and `usageMetadata` | ⚠ metadata carry | `unit:streaming.test.ts` test `ai#stream-aggregate-final-meta` (aggregation semantics derived from the framing capture) | stream-aggregate-final-meta |

## `ChatSession` history and streaming turns

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| GenerativeModel.startChat() |  | `startChat` returns a `ChatSession` seeded with `StartChatParams.history` | ✓ | `unit:upstream-ai-probes.test.ts` (I1 validateChatHistory accept/reject via startChat) + `unit:chat-session.test.ts` test `ai#chat-startchat` | chat-startchat |
| ChatSession.sendMessage() / getHistory() |  | `sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles | ⚠ clone | `unit:chat-session.test.ts` test `ai#chat-history-threads` (no capture; history threading claim) | chat-history-threads |
| ChatSession.getHistory() |  | Blocked prompts and blocked candidates are excluded from `getHistory()` | ⚠ blocked history | `unit:chat-session.test.ts` test `ai#chat-history-excludes-blocked` (upstream JSDoc contract; exercised with a scripted blocked envelope) | chat-history-excludes-blocked |
| ChatSession.sendMessage() |  | A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model` | ✓ | Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/chat-session.test.ts test `ai#chat-sendmessage-envelope` | chat-sendmessage-envelope |
| ChatSession.sendMessageStream() |  | `sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes | ✓ | `unit:chat-session.test.ts` test `ai#chat-sendmessagestream` (no capture; streaming turn claim) | chat-sendmessagestream |
| ChatSession.sendMessageStream() |  | Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug | ⚠ 2.13.0 semantics | `unit:chat-session.test.ts` test `ai#chat-stream-single-user-turn` (no capture; divergence pinned by ruling, see notes) | chat-stream-single-user-turn |
| POSSIBLE_ROLES |  | `POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]` | ✓ | `unit:chat-session.test.ts` test `ai#chat-role-vocabulary` (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role) | chat-role-vocabulary |

## Function calling

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| functionCall parts |  | A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string | ✓ | Capture ai-function-call-shape (functionCallKeySet, argsIsObjectNotString) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-part-shape` | fncall-part-shape |
| toolConfig.functionCallingConfig |  | Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP` | ✓ | Capture ai-function-call-shape (captured under mode ANY, finishReason STOP) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-mode-any` | fncall-mode-any |
| functionCall parts |  | `functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls | ✓ | Capture ai-function-call-shape (id in functionCallKeySet) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-id-present` | fncall-id-present |
| functionResponse round trip |  | A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part | ✓ | Capture ai-function-response-round replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-round-trip` | fncall-round-trip |
| functionResponse round trip |  | A replayed model functionCall turn lacking `thoughtSignature` is rejected 400 INVALID_ARGUMENT with the thought-signature message | ✓ | Capture ai-error-fncall-missing-thought-signature replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-thought-signature-required` | fncall-thought-signature-required |
| scripted engine synthesis |  | The engine mints a `thoughtSignature` on every functionCall part it synthesizes, so scripted tool round trips replay cleanly | ✓ | `unit:function-calling.test.ts` test `ai#fncall-signature-minted` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection) | fncall-signature-minted |

## `countTokens`

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| countTokens() |  | The countTokens envelope key set is exactly `promptTokensDetails`, `totalTokens` | ✓ | Capture ai-counttokens-envelope replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-envelope` | counttokens-envelope |
| countTokens() |  | An identical payload returns an identical `totalTokens` across calls | ✓ | Capture ai-counttokens-envelope (deterministicAcrossTwoCalls) replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-deterministic` | counttokens-deterministic |

## Error envelopes

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| error envelope |  | A model name production has never served fails 404 NOT_FOUND with the error key set `code`, `message`, `status` and no details | ✓ | Capture ai-error-unknown-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-unknown-model` | error-unknown-model |
| error envelope |  | A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model | ✓ | Capture ai-error-retired-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-retired-model` | error-retired-model |
| error envelope |  | An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message `API key not valid. Please pass a valid API key.` | ✓ | Capture ai-error-bad-api-key replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-api-key` | error-bad-api-key |
| error envelope |  | An empty `contents` array fails 400 INVALID_ARGUMENT with the message `contents is not specified` | ✓ | Capture ai-error-empty-contents replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-empty-contents` | error-empty-contents |
| error envelope |  | An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER | ✓ | Capture ai-error-bad-role replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-role` | error-bad-role |
| AIError |  | HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails` | ✓ | `unit:errors-counttokens.test.ts` test `ai#error-aierror-shape` (capture ai-error-bad-api-key cited as the sample envelope) | error-aierror-shape |
| AIErrorCode |  | `AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported` | ✓ | `unit:errors-counttokens.test.ts` test `ai#error-code-vocabulary` (upstream constant vocabulary) | error-code-vocabulary |

## Response helpers (`EnhancedGenerateContentResponse`)

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| response.text() |  | `text()` concatenates the text parts of the first candidate | ✓ | `unit:upstream-ai-probes.test.ts` (I3 text() across mixed parts) + `unit:helpers-schema.test.ts` test `ai#helper-text` | helper-text |
| response.text() |  | `text()` throws on bad finish reasons such as `SAFETY` and on a blocked prompt | ✓ | `unit:helpers-schema.test.ts` test `ai#helper-text-throws` (exercised with a scripted SAFETY envelope) | helper-text-throws |
| response.functionCalls() |  | `functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects | ✓ | `unit:upstream-ai-probes.test.ts` (I3 text+functionCall mix) + Capture ai-function-call-shape replayed by `unit:helpers-schema.test.ts` test `ai#helper-functioncalls` | helper-functioncalls |
| response.thoughtSummary() |  | `thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case | ✓ | `unit:upstream-ai-probes.test.ts` (I3 thoughtSummary from thought parts) + Capture ai-thinking-thought-parts replayed by `unit:helpers-schema.test.ts` test `ai#helper-thoughtsummary` | helper-thoughtsummary |
| response.inlineDataParts() |  | `inlineDataParts()` returns the `InlineDataPart` array when inlineData parts exist and undefined when none do | ✓ | `unit:helpers-schema.test.ts` test `ai#helper-inlinedataparts` (exercised with a scripted raw envelope) | helper-inlinedataparts |
| response helpers |  | Helpers tolerate omitted decoration: an envelope without `usageMetadata`, `finishReason`, or `safetyRatings` still serves `text()` without throwing | ✓ | `unit:helpers-schema.test.ts` test `ai#helper-tolerates-missing-decor` (exercised with a scripted bare envelope) | helper-tolerates-missing-decor |

## `Schema` builders

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| Schema.object() |  | `Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties` | ✓ | `unit:upstream-ai-probes.test.ts` (I2 empty optionalProperties + propertyOrdering) + `unit:helpers-schema.test.ts` test `ai#schema-object-tojson` | schema-object-tojson |
| Schema.enumString() |  | `Schema.enumString` serializes the enum values with type `string` and format `enum` | ⚠ format | `unit:helpers-schema.test.ts` test `ai#schema-string-enum` (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats) | schema-string-enum |
| Schema.string()/integer()/number()/boolean()/array() |  | Each primitive builder serializes its `SchemaType`, and `array` carries `items` | ✓ | `unit:helpers-schema.test.ts` test `ai#schema-primitives` (upstream toJSON request shape) | schema-primitives |
| Schema.anyOf() |  | `Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type | ✓ | `unit:upstream-ai-probes.test.ts` (I2 empty anyOf → invalid-schema) + `unit:helpers-schema.test.ts` test `ai#schema-anyof` | schema-anyof |
| generationConfig.responseSchema |  | A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output | ✓ | Capture ai-structured-output-shape replayed by packages/pyric/test/ai/helpers-schema.test.ts test `ai#schema-rides-request` | schema-rides-request |

## Sandbox answer engine: scripted

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| scripted engine |  | With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold | ✓ | `unit:engines.test.ts` test `ai#scripted-zero-config` (capture ai-generate-minimal-envelope cited as the shape source) | scripted-zero-config |
| scripted engine |  | The same unscripted request twice yields an identical envelope, candidates and usage included | ✓ | `unit:engines.test.ts` test `ai#scripted-deterministic` (determinism claim from the scripted authoring deltas) | scripted-deterministic |
| script(ai, entries) |  | Script entries without matchers are consumed in FIFO queue order | ✓ | `unit:engines.test.ts` test `ai#scripted-queue-order` (ruling 2 of the scripted authoring deltas) | scripted-queue-order |
| script(ai, entries) |  | Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue | ✓ | `unit:engines.test.ts` test `ai#scripted-matchers` (ruling 2 of the scripted authoring deltas) | scripted-matchers |
| script(ai, entries) |  | A raw Gemini envelope entry is returned verbatim, so an observation `behavior.raw` pastes in directly and captures are the corpus | ✓ | `unit:engines.test.ts` test `ai#scripted-raw-envelope` (ruling 3 of the scripted authoring deltas) | scripted-raw-envelope |
| script(ai, entries) |  | A `text` shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId | ✓ | `unit:engines.test.ts` test `ai#scripted-shorthand-text` (capture ai-generate-minimal-envelope cited as the expansion target) | scripted-shorthand-text |
| script(ai, entries) |  | A `functionCall` shorthand expands to a model turn whose functionCall part carries a minted `thoughtSignature` | ✓ | `unit:engines.test.ts` test `ai#scripted-shorthand-functioncall` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection) | scripted-shorthand-functioncall |
| script(ai, entries) |  | A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE | ✓ | `unit:engines.test.ts` test `ai#scripted-stream-chunks` (capture ai-generate-stream-framing cited as the framing source) | scripted-stream-chunks |
| script(ai, entries) |  | Scripted text is the one place generated text values may be asserted: `response.text()` returns the scripted string exactly | ✓ | `unit:engines.test.ts` test `ai#scripted-text-assertable` (evidence tier ruling 1: generated text is never compared anywhere else) | scripted-text-assertable |

## Sandbox answer engine: openai translation

| API | Category | Behavior | Status | Probe | # |
|---|---|---|---|---|---|
| openai engine |  | Gemini `contents` and `systemInstruction` translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role `model` | ✓ | `unit:engines.test.ts` test `ai#openai-request-translation` (translation exercised against a local OpenAI-compatible mock) | openai-request-translation |
| openai engine |  | OpenAI `tool_call` ids are matched FIFO against Gemini functionResponse parts when replaying tool history | ✓ | `unit:engines.test.ts` test `ai#openai-fifo-tool-ids` (lossy translation edge from ticket #96) | openai-fifo-tool-ids |
| openai engine |  | Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments | ✓ | `unit:engines.test.ts` test `ai#openai-buffered-fncalls` (lossy translation edge from ticket #96) | openai-buffered-fncalls |
| openai engine |  | The OpenAI `[DONE]` sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope | ✓ | `unit:engines.test.ts` test `ai#openai-done-not-forwarded` (lossy translation edge from ticket #96) | openai-done-not-forwarded |
| openai engine |  | Parts flagged `thought: true` in history are skipped when replaying to an OpenAI upstream | ✓ | `unit:engines.test.ts` test `ai#openai-thought-parts-skipped` (lossy translation edge from ticket #96) | openai-thought-parts-skipped |

## Current gaps

### Documented divergences

Known differences between Pyric and production Firebase. Each remains tracked as a non-conforming row.

| API | Behavior |
|---|---|
| getGenerativeModel(ai, modelParams) | A `models/`-prefixed name is accepted without double prefixing |
| generateContentStream() | The aggregated response carries the final chunk `finishReason` and `usageMetadata` |
| ChatSession.sendMessage() / getHistory() | `sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles |
| ChatSession.getHistory() | Blocked prompts and blocked candidates are excluded from `getHistory()` |
| ChatSession.sendMessageStream() | Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug |
| Schema.enumString() | `Schema.enumString` serializes the enum values with type `string` and format `enum` |
