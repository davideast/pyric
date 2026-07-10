---
title: "pyric/ai compatibility matrix"
navLabel: "Compatibility matrix"
group: "pyric / ai"
section: "Compat"
order: 140
---
<!-- Generated from scripts/compat/registry/*.ts. Do not edit by hand; run bun run compat:generate. -->

# `pyric/ai` compatibility matrix

This surface is climbing under Conformance Driven Development
(map: https://github.com/davideast/pyric/issues/92). Every row below was
born `unverified` at admission: the row universe and the red conformance
suites came first, the mirror implementation comes after.

The climb targets:

- `bun run compat:climb-ai` runs the red suites at
  `scripts/compat/conformance/ai`. They fail by design until the mirror
  lands; a row flips on the PR that makes its named assertions pass, and
  assertions are never weakened.
- Flip tiers per `docs/conformance/ai/cdd-deltas.md`: `oracle-backed`
  for value-deterministic claims (error envelopes, countTokens),
  `shape-backed` for claims that replay an observation's distilled shape
  facts (key sets, enum values, framing), and `sandbox-only` for the
  answer-engine seam, which has no production analogue.

Generated-content VALUES are never claims. Production output is
nondeterministic, so no row asserts on generated text, and the suites only
compare text when the scripted engine was explicitly scripted to return it
(the shape-backed tier ruling in `docs/conformance/ai/cdd-deltas.md`).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match prod but doesn't; failing probe pins it |
| — | **Unsupported**: not implemented yet (deliberately or pending) |
| ? | **Unverified**: claim not yet locked by a passing probe |

Probe references: `red:<file>` means a Bun test in
`scripts/compat/conformance/ai/<file>`. Captures live at
`scripts/oracle/observations/ai-*.json`; at zero they are cited as the
source of a row's facts, not replayed.

---

## `getAI(target)` and dispatch

| # | Behavior | Status | Probe |
|---|---|---|---|
| getai-sandbox-dispatch | `getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine | ? | red:init-dispatch.test.ts (no capture; seam claim) |
| getai-prod-dispatch | `getAI(app)` dispatches to the production `firebase/ai` backend; the returned handle carries the app | ? | red:init-dispatch.test.ts (no capture; pass-through claim) |
| getai-default-backend | With no options the backend defaults to `GoogleAIBackend` and `backendType` is `GOOGLE_AI` | ? | red:init-dispatch.test.ts (matches upstream AIOptions default) |
| getai-idempotent | Repeat `getAI` calls with the same target return a stable handle | ? | red:init-dispatch.test.ts (no capture; structural claim) |
| getai-engine-option | `getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })` selects the scripted engine explicitly and behaves identically to the zero-config default | ? | red:init-dispatch.test.ts (engine seam per docs/conformance/ai/cdd-deltas.md) |
| backend-vertex | `VertexAIBackend` carries `backendType` `VERTEX_AI` and its `location` defaults to `us-central1` | ? | red:init-dispatch.test.ts (matches upstream constructor default) |
| model-name-short | A short model name such as `gemini-flash-lite-latest` normalizes to the `models/` resource name on `GenerativeModel.model` | ? | red:init-dispatch.test.ts (upstream AIModel normalization on the GoogleAI backend) |
| model-name-prefixed | A `models/`-prefixed name is accepted without double prefixing | ? | red:init-dispatch.test.ts (no capture; normalization claim) |
| model-name-required | `getGenerativeModel` without `modelParams.model` throws an `AIError` with code `no-model` | ? | red:init-dispatch.test.ts (upstream throw contract) |
| getai-sandbox-no-network | The sandbox target with the scripted engine performs no network I/O for generateContent | ? | red:init-dispatch.test.ts (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere) |

## `GenerativeModel.generateContent` envelope

| # | Behavior | Status | Probe |
|---|---|---|---|
| generate-envelope-keys | The response envelope top-level key set is exactly `candidates`, `modelVersion`, `responseId`, `usageMetadata` | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts replays the key set at flip |
| generate-candidate-keys | The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate) | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero (candidateHasIndexOnWire); red:generate-content.test.ts |
| generate-role-model | Candidate content carries role `model` and the content key set is `parts`, `role` | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts |
| generate-finish-stop | A normal completion finishes with `finishReason` `STOP` | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts |
| generate-usage-key-set | The usageMetadata key set on a minimal text call is `candidatesTokenCount`, `promptTokenCount`, `promptTokensDetails`, `serviceTier`, `totalTokenCount` | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts |
| generate-usage-service-tier | `usageMetadata.serviceTier` rides the wire even though the 2.12.0 SDK typings do not declare it | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero (usageServiceTierPresent); red:generate-content.test.ts |
| generate-modelversion-responseid | `modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts |
| generate-string-request | A plain string request is wrapped as a single user turn before it reaches the engine | ? | red:generate-content.test.ts (no capture; upstream request formatting claim) |
| generate-system-instruction | A top-level `systemInstruction` is accepted and the response envelope shape is unaffected | ? | Capture ai-system-instruction-accepted cited, not replayed at zero; red:generate-content.test.ts |
| generate-structured-output | `responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set | ? | Capture ai-structured-output-shape cited, not replayed at zero; red:generate-content.test.ts |
| generate-thinking-signature | With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true` | ? | Capture ai-thinking-thought-parts cited, not replayed at zero (partKeySets, anyThoughtPart false); red:generate-content.test.ts |
| generate-abort-signal | A pre-aborted `SingleRequestOptions.signal` rejects the call | ? | red:generate-content.test.ts (no capture; upstream SingleRequestOptions contract) |
| generate-decoration-synthesized | Token counts are minted without a tokenizer, and the minimal envelope omits `safetyRatings`, matching the captured candidate key set | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts |

## `generateContentStream` framing and aggregation

| # | Behavior | Status | Probe |
|---|---|---|---|
| stream-async-iterable | `result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse | ? | Capture ai-generate-stream-framing cited, not replayed at zero; red:streaming.test.ts |
| stream-data-prefixed | Every SSE event is `data: ` prefixed and its payload parses as a complete JSON document | ? | Capture ai-generate-stream-framing cited, not replayed at zero (allEventsDataPrefixed); red:streaming.test.ts |
| stream-separator-crlf | SSE events are separated by CRLF CRLF | ? | Capture ai-generate-stream-framing cited, not replayed at zero (separatorIsCrlfCrlf); red:streaming.test.ts |
| stream-finish-last-chunk | `finishReason` appears only on the last chunk of a stream | ? | Capture ai-generate-stream-framing cited, not replayed at zero (finishReasonOnlyOnLastChunk); red:streaming.test.ts |
| stream-usage-every-chunk | `usageMetadata` rides every chunk, not only the last one | ? | Capture ai-generate-stream-framing cited, not replayed at zero (usageMetadataChunkIndexes covers all chunks); red:streaming.test.ts |
| stream-chunk-envelope | Every chunk carries `candidates` or `usageMetadata` | ? | Capture ai-generate-stream-framing cited, not replayed at zero (everyEventHasCandidatesOrUsage); red:streaming.test.ts |
| stream-response-aggregate | `result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts | ? | red:streaming.test.ts (aggregation semantics; text values come from an explicit script) |
| stream-aggregate-final-meta | The aggregated response carries the final chunk `finishReason` and `usageMetadata` | ? | red:streaming.test.ts (aggregation semantics derived from the framing capture) |

## `ChatSession` history and streaming turns

| # | Behavior | Status | Probe |
|---|---|---|---|
| chat-startchat | `startChat` returns a `ChatSession` seeded with `StartChatParams.history` | ? | red:chat-session.test.ts (no capture; structural claim) |
| chat-history-threads | `sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles | ? | red:chat-session.test.ts (no capture; history threading claim) |
| chat-history-excludes-blocked | Blocked prompts and blocked candidates are excluded from `getHistory()` | ? | red:chat-session.test.ts (upstream JSDoc contract; exercised with a scripted blocked envelope) |
| chat-sendmessage-envelope | A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model` | ? | Capture ai-generate-minimal-envelope cited, not replayed at zero; red:chat-session.test.ts |
| chat-sendmessagestream | `sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes | ? | red:chat-session.test.ts (no capture; streaming turn claim) |
| chat-stream-single-user-turn | Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug | ? | red:chat-session.test.ts (no capture; divergence pinned by ruling, see notes) |
| chat-role-vocabulary | `POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]` | ? | red:chat-session.test.ts (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role) |

## Function calling

| # | Behavior | Status | Probe |
|---|---|---|---|
| fncall-part-shape | A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string | ? | Capture ai-function-call-shape cited, not replayed at zero (functionCallKeySet, argsIsObjectNotString); red:function-calling.test.ts |
| fncall-mode-any | Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP` | ? | Capture ai-function-call-shape cited, not replayed at zero (captured under mode ANY, finishReason STOP); red:function-calling.test.ts |
| fncall-id-present | `functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls | ? | Capture ai-function-call-shape cited, not replayed at zero (id in functionCallKeySet); red:function-calling.test.ts |
| fncall-round-trip | A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part | ? | Capture ai-function-response-round cited, not replayed at zero; red:function-calling.test.ts |
| fncall-thought-signature-required | A replayed model functionCall turn lacking `thoughtSignature` is rejected 400 INVALID_ARGUMENT with the thought-signature message | ? | Capture ai-error-fncall-missing-thought-signature cited, not replayed at zero; red:function-calling.test.ts |
| fncall-signature-minted | The engine mints a `thoughtSignature` on every functionCall part it synthesizes, so scripted tool round trips replay cleanly | ? | Capture ai-error-fncall-missing-thought-signature cited as the motivating rejection; red:function-calling.test.ts |

## `countTokens`

| # | Behavior | Status | Probe |
|---|---|---|---|
| counttokens-envelope | The countTokens envelope key set is exactly `promptTokensDetails`, `totalTokens` | ? | Capture ai-counttokens-envelope cited, not replayed at zero; red:errors-counttokens.test.ts |
| counttokens-deterministic | An identical payload returns an identical `totalTokens` across calls | ? | Capture ai-counttokens-envelope cited, not replayed at zero (deterministicAcrossTwoCalls); red:errors-counttokens.test.ts |

## Error envelopes

| # | Behavior | Status | Probe |
|---|---|---|---|
| error-unknown-model | A model name production has never served fails 404 NOT_FOUND with the error key set `code`, `message`, `status` and no details | ? | Capture ai-error-unknown-model cited, not replayed at zero; red:errors-counttokens.test.ts |
| error-retired-model | A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model | ? | Capture ai-error-retired-model cited, not replayed at zero; red:errors-counttokens.test.ts |
| error-bad-api-key | An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message `API key not valid. Please pass a valid API key.` | ? | Capture ai-error-bad-api-key cited, not replayed at zero; red:errors-counttokens.test.ts |
| error-empty-contents | An empty `contents` array fails 400 INVALID_ARGUMENT with the message `contents is not specified` | ? | Capture ai-error-empty-contents cited, not replayed at zero; red:errors-counttokens.test.ts |
| error-bad-role | An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER | ? | Capture ai-error-bad-role cited, not replayed at zero; red:errors-counttokens.test.ts |
| error-aierror-shape | HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails` | ? | Capture ai-error-bad-api-key cited as the sample envelope, not replayed at zero; red:errors-counttokens.test.ts |
| error-code-vocabulary | `AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported` | ? | red:errors-counttokens.test.ts (upstream constant vocabulary) |

## Response helpers (`EnhancedGenerateContentResponse`)

| # | Behavior | Status | Probe |
|---|---|---|---|
| helper-text | `text()` concatenates the text parts of the first candidate | ? | red:helpers-schema.test.ts (text value asserted only because the scripted engine was scripted to return it) |
| helper-text-throws | `text()` throws on bad finish reasons such as `SAFETY` and on a blocked prompt | ? | red:helpers-schema.test.ts (exercised with a scripted SAFETY envelope) |
| helper-functioncalls | `functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects | ? | Capture ai-function-call-shape cited, not replayed at zero; red:helpers-schema.test.ts |
| helper-thoughtsummary | `thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case | ? | Capture ai-thinking-thought-parts cited, not replayed at zero (anyThoughtPart false); red:helpers-schema.test.ts |
| helper-inlinedataparts | `inlineDataParts()` returns the `InlineDataPart` array when inlineData parts exist and undefined when none do | ? | red:helpers-schema.test.ts (exercised with a scripted raw envelope) |
| helper-tolerates-missing-decor | Helpers tolerate omitted decoration: an envelope without `usageMetadata`, `finishReason`, or `safetyRatings` still serves `text()` without throwing | ? | red:helpers-schema.test.ts (exercised with a scripted bare envelope) |

## `Schema` builders

| # | Behavior | Status | Probe |
|---|---|---|---|
| schema-object-tojson | `Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties` | ? | red:helpers-schema.test.ts (upstream toJSON request shape) |
| schema-string-enum | `Schema.enumString` serializes the enum values with type `string` and format `enum` | ? | red:helpers-schema.test.ts (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats) |
| schema-primitives | Each primitive builder serializes its `SchemaType`, and `array` carries `items` | ? | red:helpers-schema.test.ts (upstream toJSON request shape) |
| schema-anyof | `Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type | ? | red:helpers-schema.test.ts (upstream toJSON request shape) |
| schema-rides-request | A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output | ? | Capture ai-structured-output-shape cited, not replayed at zero; red:helpers-schema.test.ts |

## Sandbox answer engine: scripted

| # | Behavior | Status | Probe |
|---|---|---|---|
| scripted-zero-config | With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold | ? | Capture ai-generate-minimal-envelope cited as the shape source, not replayed at zero; red:engines.test.ts |
| scripted-deterministic | The same unscripted request twice yields an identical envelope, candidates and usage included | ? | red:engines.test.ts (determinism claim from the scripted authoring deltas) |
| scripted-queue-order | Script entries without matchers are consumed in FIFO queue order | ? | red:engines.test.ts (ruling 2 of the scripted authoring deltas) |
| scripted-matchers | Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue | ? | red:engines.test.ts (ruling 2 of the scripted authoring deltas) |
| scripted-raw-envelope | A raw Gemini envelope entry is returned verbatim, so an observation `behavior.raw` pastes in directly and captures are the corpus | ? | red:engines.test.ts (ruling 3 of the scripted authoring deltas) |
| scripted-shorthand-text | A `text` shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId | ? | Capture ai-generate-minimal-envelope cited as the expansion target, not replayed at zero; red:engines.test.ts |
| scripted-shorthand-functioncall | A `functionCall` shorthand expands to a model turn whose functionCall part carries a minted `thoughtSignature` | ? | Capture ai-error-fncall-missing-thought-signature cited as the motivating rejection, not replayed at zero; red:engines.test.ts |
| scripted-stream-chunks | A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE | ? | Capture ai-generate-stream-framing cited as the framing source, not replayed at zero; red:engines.test.ts |
| scripted-text-assertable | Scripted text is the one place generated text values may be asserted: `response.text()` returns the scripted string exactly | ? | red:engines.test.ts (evidence tier ruling 1: generated text is never compared anywhere else) |

## Sandbox answer engine: openai translation

| # | Behavior | Status | Probe |
|---|---|---|---|
| openai-request-translation | Gemini `contents` and `systemInstruction` translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role `model` | ? | red:engines.test.ts (translation exercised against a local OpenAI-compatible mock) |
| openai-fifo-tool-ids | OpenAI `tool_call` ids are matched FIFO against Gemini functionResponse parts when replaying tool history | ? | red:engines.test.ts (lossy translation edge from ticket #96) |
| openai-buffered-fncalls | Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments | ? | red:engines.test.ts (lossy translation edge from ticket #96) |
| openai-done-not-forwarded | The OpenAI `[DONE]` sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope | ? | red:engines.test.ts (lossy translation edge from ticket #96) |
| openai-thought-parts-skipped | Parts flagged `thought: true` in history are skipped when replaying to an OpenAI upstream | ? | red:engines.test.ts (lossy translation edge from ticket #96) |

## Production arm pass-through

| # | Behavior | Status | Probe |
|---|---|---|---|
| prod-passthrough-generate | With an app target the mirror passes `generateContent` through to `firebase/ai` unmodified: the request body reaches the production base URL byte-identical | ? | red:engines.test.ts (fetch interception; no capture needed for pass-through) |
| prod-passthrough-errors | Production error envelopes surface unchanged through the prod arm as `AIError` with the wire status and message | ? | red:engines.test.ts (fetch interception replaying the captured bad-api-key envelope shape) |
