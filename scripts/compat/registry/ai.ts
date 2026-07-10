import type { CompatibilityDocBlock, CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The ai surface registry, admitted at zero under Conformance Driven
 * Development (map https://github.com/davideast/pyric/issues/92).
 *
 * Every row is born status 'unverified' and automation 'unverified'. The red
 * conformance suites under scripts/compat/conformance/ai name every row id
 * and fail by design until the mirror lands. Where a row cites an ai-*
 * observation, the capture is cited at zero and replayed by the suite at
 * flip time. Intended flip tiers (per docs/conformance/ai/cdd-deltas.md)
 * are recorded in row notes, never in the automation field at zero.
 */

interface AiRowDef {
  rowRef: string;
  section: string;
  api: string;
  behavior: string;
  evidence: string;
  observations?: string[];
  tests: string[];
  notes?: string;
  risk?: string[];
  riskScore?: number;
  riskReasons?: string[];
}

const SUITE = 'scripts/compat/conformance/ai';

function row(def: AiRowDef): CompatibilityRow {
  return {
    id: `ai#${def.rowRef}`,
    surface: 'ai',
    aliases: [],
    rowRef: def.rowRef,
    rowNumber: null,
    section: def.section,
    api: def.api,
    behavior: def.behavior,
    status: 'unverified',
    evidence: def.evidence,
    risk: def.risk ?? [],
    riskScore: def.riskScore ?? 0,
    riskReasons: def.riskReasons ?? [],
    automation: 'unverified',
    oracleObservations: def.observations ?? [],
    conformanceTests: def.tests.map((file) => `${SUITE}/${file}`),
    ...(def.notes ? { notes: def.notes } : {}),
  };
}

const SHAPE_NOTE = 'Flip target: shape-backed. The suite replays the distilled shape facts; generated values are never compared.';
const ORACLE_NOTE = 'Flip target: oracle-backed. Production is value-deterministic for this claim.';
const ENGINE_NOTE = 'Intended tier at flip: sandbox-only; the engine seam has no production analogue. Automation kept unverified at zero.';

// Section: initialization and dispatch -------------------------------------

const SEC_INIT = '`getAI(target)` and dispatch';
const initRows: CompatibilityRow[] = [
  row({
    rowRef: 'getai-sandbox-dispatch',
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: '`getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine',
    evidence: 'red:init-dispatch.test.ts (no capture; seam claim)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed; structural dispatch claim.',
  }),
  row({
    rowRef: 'getai-prod-dispatch',
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: '`getAI(app)` dispatches to the production `firebase/ai` backend; the returned handle carries the app',
    evidence: 'red:init-dispatch.test.ts (no capture; pass-through claim)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Prod arm is pass-through; the mirror adds no translation.',
  }),
  row({
    rowRef: 'getai-default-backend',
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: 'With no options the backend defaults to `GoogleAIBackend` and `backendType` is `GOOGLE_AI`',
    evidence: 'red:init-dispatch.test.ts (matches upstream AIOptions default)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'getai-idempotent',
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: 'Repeat `getAI` calls with the same target return a stable handle',
    evidence: 'red:init-dispatch.test.ts (no capture; structural claim)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'getai-engine-option',
    section: SEC_INIT,
    api: 'getAI(target, options)',
    behavior: '`getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })` selects the scripted engine explicitly and behaves identically to the zero-config default',
    evidence: 'red:init-dispatch.test.ts (engine seam per docs/conformance/ai/cdd-deltas.md)',
    tests: ['init-dispatch.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'backend-vertex',
    section: SEC_INIT,
    api: 'VertexAIBackend',
    behavior: '`VertexAIBackend` carries `backendType` `VERTEX_AI` and its `location` defaults to `us-central1`',
    evidence: 'red:init-dispatch.test.ts (matches upstream constructor default)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'model-name-short',
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: 'A short model name such as `gemini-flash-lite-latest` normalizes to the `models/` resource name on `GenerativeModel.model`',
    evidence: 'red:init-dispatch.test.ts (upstream AIModel normalization on the GoogleAI backend)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'model-name-prefixed',
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: 'A `models/`-prefixed name is accepted without double prefixing',
    evidence: 'red:init-dispatch.test.ts (no capture; normalization claim)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'model-name-required',
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: '`getGenerativeModel` without `modelParams.model` throws an `AIError` with code `no-model`',
    evidence: 'red:init-dispatch.test.ts (upstream throw contract)',
    tests: ['init-dispatch.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'getai-sandbox-no-network',
    section: SEC_INIT,
    api: 'getAI(sandbox)',
    behavior: 'The sandbox target with the scripted engine performs no network I/O for generateContent',
    evidence: 'red:init-dispatch.test.ts (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere)',
    tests: ['init-dispatch.test.ts'],
    notes: ENGINE_NOTE,
  }),
];

// Section: GenerativeModel.generateContent envelope -------------------------

const SEC_GENERATE = '`GenerativeModel.generateContent` envelope';
const generateRows: CompatibilityRow[] = [
  row({
    rowRef: 'generate-envelope-keys',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The response envelope top-level key set is exactly `candidates`, `modelVersion`, `responseId`, `usageMetadata`',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts replays the key set at flip',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-candidate-keys',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate)',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero (candidateHasIndexOnWire); red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-role-model',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'Candidate content carries role `model` and the content key set is `parts`, `role`',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-finish-stop',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'A normal completion finishes with `finishReason` `STOP`',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-usage-key-set',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The usageMetadata key set on a minimal text call is `candidatesTokenCount`, `promptTokenCount`, `promptTokensDetails`, `serviceTier`, `totalTokenCount`',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-usage-service-tier',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: '`usageMetadata.serviceTier` rides the wire even though the 2.12.0 SDK typings do not declare it',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero (usageServiceTierPresent); red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-modelversion-responseid',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: '`modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: 'Synthesized decoration (ruling 2 in docs/conformance/ai/cdd-deltas.md); the values are minted, only presence and determinism are claims. ' + SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-string-request',
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'A plain string request is wrapped as a single user turn before it reaches the engine',
    evidence: 'red:generate-content.test.ts (no capture; upstream request formatting claim)',
    tests: ['generate-content.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'generate-system-instruction',
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'A top-level `systemInstruction` is accepted and the response envelope shape is unaffected',
    evidence: 'Capture ai-system-instruction-accepted cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-system-instruction-accepted'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'generate-structured-output',
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: '`responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set',
    evidence: 'Capture ai-structured-output-shape cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-structured-output-shape'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE + ' The parsed key set is a shape fact; the JSON values are not claims.',
  }),
  row({
    rowRef: 'generate-thinking-signature',
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true`',
    evidence: 'Capture ai-thinking-thought-parts cited, not replayed at zero (partKeySets, anyThoughtPart false); red:generate-content.test.ts',
    observations: ['ai-thinking-thought-parts'],
    tests: ['generate-content.test.ts'],
    notes: SHAPE_NOTE + ' Lite models return signatures without thought parts; that is the captured fact.',
  }),
  row({
    rowRef: 'generate-abort-signal',
    section: SEC_GENERATE,
    api: 'generateContent(request, singleRequestOptions)',
    behavior: 'A pre-aborted `SingleRequestOptions.signal` rejects the call',
    evidence: 'red:generate-content.test.ts (no capture; upstream SingleRequestOptions contract)',
    tests: ['generate-content.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'generate-decoration-synthesized',
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'Token counts are minted without a tokenizer, and the minimal envelope omits `safetyRatings`, matching the captured candidate key set',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:generate-content.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: 'Ruling 2 in docs/conformance/ai/cdd-deltas.md: synthesized decoration is a standing by-design divergence class, documented per row and never hidden. ' + SHAPE_NOTE,
  }),
];

// Section: generateContentStream --------------------------------------------

const SEC_STREAM = '`generateContentStream` framing and aggregation';
const streamRows: CompatibilityRow[] = [
  row({
    rowRef: 'stream-async-iterable',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero; red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'stream-data-prefixed',
    section: SEC_STREAM,
    api: 'generateContentStream() wire framing',
    behavior: 'Every SSE event is `data: ` prefixed and its payload parses as a complete JSON document',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero (allEventsDataPrefixed); red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE + ' Asserted through the framing encoder the scripting module exports, since the SDK-level stream yields parsed objects.',
  }),
  row({
    rowRef: 'stream-separator-crlf',
    section: SEC_STREAM,
    api: 'generateContentStream() wire framing',
    behavior: 'SSE events are separated by CRLF CRLF',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero (separatorIsCrlfCrlf); red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE + ' Asserted through the framing encoder the scripting module exports.',
  }),
  row({
    rowRef: 'stream-finish-last-chunk',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`finishReason` appears only on the last chunk of a stream',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero (finishReasonOnlyOnLastChunk); red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'stream-usage-every-chunk',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`usageMetadata` rides every chunk, not only the last one',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero (usageMetadataChunkIndexes covers all chunks); red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'stream-chunk-envelope',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: 'Every chunk carries `candidates` or `usageMetadata`',
    evidence: 'Capture ai-generate-stream-framing cited, not replayed at zero (everyEventHasCandidatesOrUsage); red:streaming.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'stream-response-aggregate',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts',
    evidence: 'red:streaming.test.ts (aggregation semantics; text values come from an explicit script)',
    tests: ['streaming.test.ts'],
    notes: 'Flip target: unit-backed. Text equality is only asserted because the scripted engine was explicitly scripted to return it.',
  }),
  row({
    rowRef: 'stream-aggregate-final-meta',
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: 'The aggregated response carries the final chunk `finishReason` and `usageMetadata`',
    evidence: 'red:streaming.test.ts (aggregation semantics derived from the framing capture)',
    tests: ['streaming.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
];

// Section: ChatSession -------------------------------------------------------

const SEC_CHAT = '`ChatSession` history and streaming turns';
const chatRows: CompatibilityRow[] = [
  row({
    rowRef: 'chat-startchat',
    section: SEC_CHAT,
    api: 'GenerativeModel.startChat()',
    behavior: '`startChat` returns a `ChatSession` seeded with `StartChatParams.history`',
    evidence: 'red:chat-session.test.ts (no capture; structural claim)',
    tests: ['chat-session.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'chat-history-threads',
    section: SEC_CHAT,
    api: 'ChatSession.sendMessage() / getHistory()',
    behavior: '`sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles',
    evidence: 'red:chat-session.test.ts (no capture; history threading claim)',
    tests: ['chat-session.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'chat-history-excludes-blocked',
    section: SEC_CHAT,
    api: 'ChatSession.getHistory()',
    behavior: 'Blocked prompts and blocked candidates are excluded from `getHistory()`',
    evidence: 'red:chat-session.test.ts (upstream JSDoc contract; exercised with a scripted blocked envelope)',
    tests: ['chat-session.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'chat-sendmessage-envelope',
    section: SEC_CHAT,
    api: 'ChatSession.sendMessage()',
    behavior: 'A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model`',
    evidence: 'Capture ai-generate-minimal-envelope cited, not replayed at zero; red:chat-session.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['chat-session.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'chat-sendmessagestream',
    section: SEC_CHAT,
    api: 'ChatSession.sendMessageStream()',
    behavior: '`sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes',
    evidence: 'red:chat-session.test.ts (no capture; streaming turn claim)',
    tests: ['chat-session.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'chat-stream-single-user-turn',
    section: SEC_CHAT,
    api: 'ChatSession.sendMessageStream()',
    behavior: 'Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug',
    evidence: 'red:chat-session.test.ts (no capture; divergence pinned by ruling, see notes)',
    tests: ['chat-session.test.ts'],
    notes: 'Ruling 3 in docs/conformance/ai/cdd-deltas.md: the installed 2.12.0 duplicates the user turn, fixed upstream in 2.13.0. Reproducing a known upstream bug harms the developer the sandbox exists for, so the mirror ships the fix. Born unverified like every row; flips to diverged-documented against the installed pin when the implementation lands.',
  }),
  row({
    rowRef: 'chat-role-vocabulary',
    section: SEC_CHAT,
    api: 'POSSIBLE_ROLES',
    behavior: '`POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]`',
    evidence: 'red:chat-session.test.ts (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role)',
    tests: ['chat-session.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
];

// Section: function calling --------------------------------------------------

const SEC_FNCALL = 'Function calling';
const fncallRows: CompatibilityRow[] = [
  row({
    rowRef: 'fncall-part-shape',
    section: SEC_FNCALL,
    api: 'functionCall parts',
    behavior: 'A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string',
    evidence: 'Capture ai-function-call-shape cited, not replayed at zero (functionCallKeySet, argsIsObjectNotString); red:function-calling.test.ts',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
    notes: SHAPE_NOTE + ' The parsed-object args shape is the load-bearing difference from OpenAI tool_calls.',
  }),
  row({
    rowRef: 'fncall-mode-any',
    section: SEC_FNCALL,
    api: 'toolConfig.functionCallingConfig',
    behavior: 'Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP`',
    evidence: 'Capture ai-function-call-shape cited, not replayed at zero (captured under mode ANY, finishReason STOP); red:function-calling.test.ts',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'fncall-id-present',
    section: SEC_FNCALL,
    api: 'functionCall parts',
    behavior: '`functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls',
    evidence: 'Capture ai-function-call-shape cited, not replayed at zero (id in functionCallKeySet); red:function-calling.test.ts',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
    notes: SHAPE_NOTE + ' The upstream JSDoc is self-contradictory about backend id support; the capture is the fact.',
  }),
  row({
    rowRef: 'fncall-round-trip',
    section: SEC_FNCALL,
    api: 'functionResponse round trip',
    behavior: 'A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part',
    evidence: 'Capture ai-function-response-round cited, not replayed at zero; red:function-calling.test.ts',
    observations: ['ai-function-response-round'],
    tests: ['function-calling.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'fncall-thought-signature-required',
    section: SEC_FNCALL,
    api: 'functionResponse round trip',
    behavior: 'A replayed model functionCall turn lacking `thoughtSignature` is rejected 400 INVALID_ARGUMENT with the thought-signature message',
    evidence: 'Capture ai-error-fncall-missing-thought-signature cited, not replayed at zero; red:function-calling.test.ts',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['function-calling.test.ts'],
    risk: ['error-code', 'specific-value'],
    riskScore: 2,
    riskReasons: ['asserts production error status and message text that can drift on re-capture'],
    notes: 'Flip target: oracle-backed. No SDK typing or reference doc states this requirement; the capture is the only evidence.',
  }),
  row({
    rowRef: 'fncall-signature-minted',
    section: SEC_FNCALL,
    api: 'scripted engine synthesis',
    behavior: 'The engine mints a `thoughtSignature` on every functionCall part it synthesizes, so scripted tool round trips replay cleanly',
    evidence: 'Capture ai-error-fncall-missing-thought-signature cited as the motivating rejection; red:function-calling.test.ts',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['function-calling.test.ts'],
    notes: ENGINE_NOTE + ' Ruling 3 of the scripted authoring deltas names this mint.',
  }),
];

// Section: countTokens -------------------------------------------------------

const SEC_COUNT = '`countTokens`';
const countRows: CompatibilityRow[] = [
  row({
    rowRef: 'counttokens-envelope',
    section: SEC_COUNT,
    api: 'countTokens()',
    behavior: 'The countTokens envelope key set is exactly `promptTokensDetails`, `totalTokens`',
    evidence: 'Capture ai-counttokens-envelope cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-counttokens-envelope'],
    tests: ['errors-counttokens.test.ts'],
    notes: ORACLE_NOTE,
  }),
  row({
    rowRef: 'counttokens-deterministic',
    section: SEC_COUNT,
    api: 'countTokens()',
    behavior: 'An identical payload returns an identical `totalTokens` across calls',
    evidence: 'Capture ai-counttokens-envelope cited, not replayed at zero (deterministicAcrossTwoCalls); red:errors-counttokens.test.ts',
    observations: ['ai-counttokens-envelope'],
    tests: ['errors-counttokens.test.ts'],
    notes: ORACLE_NOTE + ' The sandbox count need not equal the production count; determinism is the claim.',
  }),
];

// Section: error envelopes ---------------------------------------------------

const SEC_ERRORS = 'Error envelopes';
const ERROR_RISK = {
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
};
const errorRows: CompatibilityRow[] = [
  row({
    rowRef: 'error-unknown-model',
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'A model name production has never served fails 404 NOT_FOUND with the error key set `code`, `message`, `status` and no details',
    evidence: 'Capture ai-error-unknown-model cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-unknown-model'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: ORACLE_NOTE,
  }),
  row({
    rowRef: 'error-retired-model',
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model',
    evidence: 'Capture ai-error-retired-model cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-retired-model'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: ORACLE_NOTE + ' Production distinguishes never-existed from retired; the mirror must too.',
  }),
  row({
    rowRef: 'error-bad-api-key',
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message `API key not valid. Please pass a valid API key.`',
    evidence: 'Capture ai-error-bad-api-key cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-bad-api-key'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: ORACLE_NOTE + ' detailTypes is a set; the messaging effort found details ordering is not stable.',
  }),
  row({
    rowRef: 'error-empty-contents',
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An empty `contents` array fails 400 INVALID_ARGUMENT with the message `contents is not specified`',
    evidence: 'Capture ai-error-empty-contents cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-empty-contents'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: ORACLE_NOTE,
  }),
  row({
    rowRef: 'error-bad-role',
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER',
    evidence: 'Capture ai-error-bad-role cited, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-bad-role'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: ORACLE_NOTE + ' The wire role vocabulary is wider than the SDK POSSIBLE_ROLES constant.',
  }),
  row({
    rowRef: 'error-aierror-shape',
    section: SEC_ERRORS,
    api: 'AIError',
    behavior: 'HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails`',
    evidence: 'Capture ai-error-bad-api-key cited as the sample envelope, not replayed at zero; red:errors-counttokens.test.ts',
    observations: ['ai-error-bad-api-key'],
    tests: ['errors-counttokens.test.ts'],
    notes: 'Flip target: unit-backed. The client-side error class shape wraps the oracle-backed wire envelope.',
  }),
  row({
    rowRef: 'error-code-vocabulary',
    section: SEC_ERRORS,
    api: 'AIErrorCode',
    behavior: '`AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported`',
    evidence: 'red:errors-counttokens.test.ts (upstream constant vocabulary)',
    tests: ['errors-counttokens.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
];

// Section: response helpers ----------------------------------------------------

const SEC_HELPERS = 'Response helpers (`EnhancedGenerateContentResponse`)';
const helperRows: CompatibilityRow[] = [
  row({
    rowRef: 'helper-text',
    section: SEC_HELPERS,
    api: 'response.text()',
    behavior: '`text()` concatenates the text parts of the first candidate',
    evidence: 'red:helpers-schema.test.ts (text value asserted only because the scripted engine was scripted to return it)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'helper-text-throws',
    section: SEC_HELPERS,
    api: 'response.text()',
    behavior: '`text()` throws on bad finish reasons such as `SAFETY` and on a blocked prompt',
    evidence: 'red:helpers-schema.test.ts (exercised with a scripted SAFETY envelope)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'helper-functioncalls',
    section: SEC_HELPERS,
    api: 'response.functionCalls()',
    behavior: '`functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects',
    evidence: 'Capture ai-function-call-shape cited, not replayed at zero; red:helpers-schema.test.ts',
    observations: ['ai-function-call-shape'],
    tests: ['helpers-schema.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'helper-thoughtsummary',
    section: SEC_HELPERS,
    api: 'response.thoughtSummary()',
    behavior: '`thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case',
    evidence: 'Capture ai-thinking-thought-parts cited, not replayed at zero (anyThoughtPart false); red:helpers-schema.test.ts',
    observations: ['ai-thinking-thought-parts'],
    tests: ['helpers-schema.test.ts'],
    notes: SHAPE_NOTE,
  }),
  row({
    rowRef: 'helper-inlinedataparts',
    section: SEC_HELPERS,
    api: 'response.inlineDataParts()',
    behavior: '`inlineDataParts()` returns the `InlineDataPart` array when inlineData parts exist and undefined when none do',
    evidence: 'red:helpers-schema.test.ts (exercised with a scripted raw envelope)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'helper-tolerates-missing-decor',
    section: SEC_HELPERS,
    api: 'response helpers',
    behavior: 'Helpers tolerate omitted decoration: an envelope without `usageMetadata`, `finishReason`, or `safetyRatings` still serves `text()` without throwing',
    evidence: 'red:helpers-schema.test.ts (exercised with a scripted bare envelope)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
];

// Section: Schema builders ----------------------------------------------------

const SEC_SCHEMA = '`Schema` builders';
const schemaRows: CompatibilityRow[] = [
  row({
    rowRef: 'schema-object-tojson',
    section: SEC_SCHEMA,
    api: 'Schema.object()',
    behavior: '`Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties`',
    evidence: 'red:helpers-schema.test.ts (upstream toJSON request shape)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'schema-string-enum',
    section: SEC_SCHEMA,
    api: 'Schema.enumString()',
    behavior: '`Schema.enumString` serializes the enum values with type `string` and format `enum`',
    evidence: 'red:helpers-schema.test.ts (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'schema-primitives',
    section: SEC_SCHEMA,
    api: 'Schema.string()/integer()/number()/boolean()/array()',
    behavior: 'Each primitive builder serializes its `SchemaType`, and `array` carries `items`',
    evidence: 'red:helpers-schema.test.ts (upstream toJSON request shape)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'schema-anyof',
    section: SEC_SCHEMA,
    api: 'Schema.anyOf()',
    behavior: '`Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type',
    evidence: 'red:helpers-schema.test.ts (upstream toJSON request shape)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Flip target: unit-backed.',
  }),
  row({
    rowRef: 'schema-rides-request',
    section: SEC_SCHEMA,
    api: 'generationConfig.responseSchema',
    behavior: 'A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output',
    evidence: 'Capture ai-structured-output-shape cited, not replayed at zero; red:helpers-schema.test.ts',
    observations: ['ai-structured-output-shape'],
    tests: ['helpers-schema.test.ts'],
    notes: SHAPE_NOTE,
  }),
];

// Section: scripted engine -----------------------------------------------------

const SEC_SCRIPTED = 'Sandbox answer engine: scripted';
const scriptedRows: CompatibilityRow[] = [
  row({
    rowRef: 'scripted-zero-config',
    section: SEC_SCRIPTED,
    api: 'scripted engine',
    behavior: 'With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold',
    evidence: 'Capture ai-generate-minimal-envelope cited as the shape source, not replayed at zero; red:engines.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE + ' Ruling 1 of the scripted authoring deltas: tests and demos never hang on missing setup.',
  }),
  row({
    rowRef: 'scripted-deterministic',
    section: SEC_SCRIPTED,
    api: 'scripted engine',
    behavior: 'The same unscripted request twice yields an identical envelope, candidates and usage included',
    evidence: 'red:engines.test.ts (determinism claim from the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-queue-order',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Script entries without matchers are consumed in FIFO queue order',
    evidence: 'red:engines.test.ts (ruling 2 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-matchers',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue',
    evidence: 'red:engines.test.ts (ruling 2 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-raw-envelope',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A raw Gemini envelope entry is returned verbatim, so an observation `behavior.raw` pastes in directly and captures are the corpus',
    evidence: 'red:engines.test.ts (ruling 3 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-shorthand-text',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A `text` shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId',
    evidence: 'Capture ai-generate-minimal-envelope cited as the expansion target, not replayed at zero; red:engines.test.ts',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE + ' One synthesizer owns the shape facts (ruling 3 of the scripted authoring deltas).',
  }),
  row({
    rowRef: 'scripted-shorthand-functioncall',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A `functionCall` shorthand expands to a model turn whose functionCall part carries a minted `thoughtSignature`',
    evidence: 'Capture ai-error-fncall-missing-thought-signature cited as the motivating rejection, not replayed at zero; red:engines.test.ts',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-stream-chunks',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE',
    evidence: 'Capture ai-generate-stream-framing cited as the framing source, not replayed at zero; red:engines.test.ts',
    observations: ['ai-generate-stream-framing'],
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE + ' Ruling 4 of the scripted authoring deltas.',
  }),
  row({
    rowRef: 'scripted-text-assertable',
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Scripted text is the one place generated text values may be asserted: `response.text()` returns the scripted string exactly',
    evidence: 'red:engines.test.ts (evidence tier ruling 1: generated text is never compared anywhere else)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
];

// Section: openai engine -------------------------------------------------------

const SEC_OPENAI = 'Sandbox answer engine: openai translation';
const openaiRows: CompatibilityRow[] = [
  row({
    rowRef: 'openai-request-translation',
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Gemini `contents` and `systemInstruction` translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role `model`',
    evidence: 'red:engines.test.ts (translation exercised against a local OpenAI-compatible mock)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-fifo-tool-ids',
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'OpenAI `tool_call` ids are matched FIFO against Gemini functionResponse parts when replaying tool history',
    evidence: 'red:engines.test.ts (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE + ' Documented lossy edge: Gemini ids are optional, so ordering is the join key.',
  }),
  row({
    rowRef: 'openai-buffered-fncalls',
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments',
    evidence: 'red:engines.test.ts (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-done-not-forwarded',
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'The OpenAI `[DONE]` sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope',
    evidence: 'red:engines.test.ts (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-thought-parts-skipped',
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Parts flagged `thought: true` in history are skipped when replaying to an OpenAI upstream',
    evidence: 'red:engines.test.ts (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    notes: ENGINE_NOTE,
  }),
];

// Section: production arm ------------------------------------------------------

const SEC_PROD = 'Production arm pass-through';
const prodRows: CompatibilityRow[] = [
  row({
    rowRef: 'prod-passthrough-generate',
    section: SEC_PROD,
    api: 'getAI(app) arm',
    behavior: 'With an app target the mirror passes `generateContent` through to `firebase/ai` unmodified: the request body reaches the production base URL byte-identical',
    evidence: 'red:engines.test.ts (fetch interception; no capture needed for pass-through)',
    tests: ['engines.test.ts'],
    notes: 'Prod arm adds no translation. Flip target: unit-backed.',
  }),
  row({
    rowRef: 'prod-passthrough-errors',
    section: SEC_PROD,
    api: 'getAI(app) arm',
    behavior: 'Production error envelopes surface unchanged through the prod arm as `AIError` with the wire status and message',
    evidence: 'red:engines.test.ts (fetch interception replaying the captured bad-api-key envelope shape)',
    tests: ['engines.test.ts'],
    notes: 'Prod arm adds no translation. Flip target: unit-backed.',
  }),
];

// Doc assembly -------------------------------------------------------------

const header = `# \`pyric/ai\` compatibility matrix

This surface is climbing under Conformance Driven Development
(map: https://github.com/davideast/pyric/issues/92). Every row below was
born \`unverified\` at admission: the row universe and the red conformance
suites came first, the mirror implementation comes after.

The climb targets:

- \`bun run compat:climb-ai\` runs the red suites at
  \`scripts/compat/conformance/ai\`. They fail by design until the mirror
  lands; a row flips on the PR that makes its named assertions pass, and
  assertions are never weakened.
- Flip tiers per \`docs/conformance/ai/cdd-deltas.md\`: \`oracle-backed\`
  for value-deterministic claims (error envelopes, countTokens),
  \`shape-backed\` for claims that replay an observation's distilled shape
  facts (key sets, enum values, framing), and \`sandbox-only\` for the
  answer-engine seam, which has no production analogue.

Generated-content VALUES are never claims. Production output is
nondeterministic, so no row asserts on generated text, and the suites only
compare text when the scripted engine was explicitly scripted to return it
(the shape-backed tier ruling in \`docs/conformance/ai/cdd-deltas.md\`).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match prod but doesn't; failing probe pins it |
| — | **Unsupported**: not implemented yet (deliberately or pending) |
| ? | **Unverified**: claim not yet locked by a passing probe |

Probe references: \`red:<file>\` means a Bun test in
\`scripts/compat/conformance/ai/<file>\`. Captures live at
\`scripts/oracle/observations/ai-*.json\`; at zero they are cited as the
source of a row's facts, not replayed.

---
`;

function table(title: string, rows: CompatibilityRow[]): CompatibilityDocBlock {
  return { kind: 'table', prefix: `## ${title}\n`, rows };
}

export const aiRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai',
  compatPath: 'packages/pyric/docs/ai/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: header },
    table(SEC_INIT, initRows),
    table(SEC_GENERATE, generateRows),
    table(SEC_STREAM, streamRows),
    table(SEC_CHAT, chatRows),
    table(SEC_FNCALL, fncallRows),
    table(SEC_COUNT, countRows),
    table(SEC_ERRORS, errorRows),
    table(SEC_HELPERS, helperRows),
    table(SEC_SCHEMA, schemaRows),
    table(SEC_SCRIPTED, scriptedRows),
    table(SEC_OPENAI, openaiRows),
    table(SEC_PROD, prodRows),
  ],
};
