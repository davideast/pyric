import type {
  Automation,
  CompatStatus,
  CompatibilityDocBlock,
  CompatibilityRow,
  CompatibilitySurfaceRegistry,
} from './types.ts';

/**
 * The ai surface registry, admitted at zero under Conformance Driven
 * Development (map https://github.com/davideast/pyric/issues/92).
 *
 * Every row was born status 'unverified' and automation 'unverified'; the
 * red conformance suites under packages/pyric/test/ai named every
 * row id and failed by design until the mirror landed. The mirror is in
 * (commit e0cea50) and the climb lane passes 80 of 80 with no assertion
 * weakened, so every row is flipped: the automation field records the
 * evidence tier per packages/conformance/docs/ai/cdd-deltas.md, and status records
 * conformance, with six documented divergences from the installed 2.12.0
 * pinned in row notes.
 */

interface AiRowDef {
  rowRef: string;
  section: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  queryable?: false;
  /** Defaults to 'conforms'; set only on diverged-documented rows. */
  status?: CompatStatus;
  statusNote?: string;
  automation: Automation;
  evidence: string;
  observations?: string[];
  tests: string[];
  exceptionReason?: string;
  notes?: string;
  risk?: string[];
  riskScore?: number;
  riskReasons?: string[];
}

const SUITE = 'packages/pyric/test/ai';

function row(def: AiRowDef): CompatibilityRow {
  return {
    id: `ai#${def.rowRef}`,
    surface: 'ai',
    aliases: [],
    featureKeys: def.featureKeys,
    ...(def.queryable === false ? { queryable: false as const } : {}),
    rowRef: def.rowRef,
    rowNumber: null,
    section: def.section,
    api: def.api,
    behavior: def.behavior,
    status: def.status ?? 'conforms',
    ...(def.statusNote ? { statusNote: def.statusNote } : {}),
    evidence: def.evidence,
    risk: def.risk ?? [],
    riskScore: def.riskScore ?? 0,
    riskReasons: def.riskReasons ?? [],
    automation: def.automation,
    oracleObservations: def.observations ?? [],
    conformanceTests: def.tests.map((file) => `${SUITE}/${file}`),
    ...(def.exceptionReason ? { exceptionReason: def.exceptionReason } : {}),
    ...(def.notes ? { notes: def.notes } : {}),
  };
}

const ENGINE_EXCEPTION = 'answer-engine seam; no production counterpart to observe';

const ENGINE_NOTE = 'The engine seam has no production analogue; sandbox-only per packages/conformance/docs/ai/cdd-deltas.md.';

// Section: initialization and dispatch -------------------------------------

const SEC_INIT = '`getAI(target)` and dispatch';
const initRows: CompatibilityRow[] = [
  row({
    rowRef: 'getai-sandbox-dispatch',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: '`getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#getai-sandbox-dispatch` (no capture; structural dispatch claim)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'getai-app-dispatch',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: 'After package resolution selects the mirror, `getAI(app)` uses the app\'s sandbox and the returned handle carries the app',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#getai-app-dispatch` (package-resolution dispatch claim)',
    tests: ['instances.test.ts'],
    notes: 'Production code keeps resolving firebase/ai; the pyric/ai module contains no production dispatch.',
  }),
  row({
    rowRef: 'getai-default-backend',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: 'With no options the backend defaults to `GoogleAIBackend`, `backendType` is `GOOGLE_AI`, and the AI handle location is the empty string',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#getai-default-backend` (matches upstream AIOptions default)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'getai-idempotent',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(target)',
    behavior: 'Repeat `getAI` calls with the same target return a stable handle',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#getai-idempotent` (no capture; structural claim)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'getai-engine-option',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(target, options)',
    behavior: '`getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })` selects the scripted engine explicitly and behaves identically to the zero-config default',
    automation: 'sandbox-only',
    evidence: '`unit:instances.test.ts` test `ai#getai-engine-option` (engine seam per packages/conformance/docs/ai/cdd-deltas.md)',
    tests: ['instances.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'backend-vertex',
    featureKeys: ["VertexAIBackend"],
    section: SEC_INIT,
    api: 'VertexAIBackend',
    behavior: '`VertexAIBackend` carries `backendType` `VERTEX_AI`; its location and the resulting AI handle location default to `us-central1`',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#backend-vertex` (matches upstream constructor default)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'model-name-short',
    featureKeys: ["getGenerativeModel"],
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: 'A short model name such as `gemini-flash-lite-latest` normalizes to the `models/` resource name on `GenerativeModel.model`',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#model-name-short` (upstream AIModel normalization on the GoogleAI backend)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'model-name-prefixed',
    featureKeys: ["getGenerativeModel"],
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: 'A `models/`-prefixed name is accepted without double prefixing',
    status: 'diverged-documented',
    statusNote: 'normalization',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#model-name-prefixed` (no capture; normalization claim)',
    tests: ['instances.test.ts'],
    notes: 'Pinned delta vs installed 2.12.0: the installed AIModel double-prefixes an already `models/`-prefixed name; the mirror normalizes without the wart (packages/pyric/src/ai/models.ts).',
  }),
  row({
    rowRef: 'model-name-required',
    featureKeys: ["getGenerativeModel"],
    section: SEC_INIT,
    api: 'getGenerativeModel(ai, modelParams)',
    behavior: '`getGenerativeModel` without `modelParams.model` throws an `AIError` with code `no-model`',
    automation: 'unit-backed',
    evidence: '`unit:instances.test.ts` test `ai#model-name-required` (upstream throw contract)',
    tests: ['instances.test.ts'],
  }),
  row({
    rowRef: 'getai-sandbox-no-network',
    featureKeys: ["getAI"],
    section: SEC_INIT,
    api: 'getAI(sandbox)',
    behavior: 'The sandbox target with the scripted engine performs no network I/O for generateContent',
    automation: 'sandbox-only',
    evidence: '`unit:instances.test.ts` test `ai#getai-sandbox-no-network` (ruling 1 of the engine placement deltas: the scripted engine does no I/O anywhere)',
    tests: ['instances.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
];

// Section: GenerativeModel.generateContent envelope -------------------------

const SEC_GENERATE = '`GenerativeModel.generateContent` envelope';
const generateRows: CompatibilityRow[] = [
  row({
    rowRef: 'generate-envelope-keys',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The response envelope top-level key set is exactly `candidates`, `modelVersion`, `responseId`, `usageMetadata`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-envelope-keys`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-candidate-keys',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The candidate key set is `content`, `finishReason`, `index`, and `index` is present on the wire (0 for the single candidate)',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope (candidateHasIndexOnWire) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-candidate-keys`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-role-model',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'Candidate content carries role `model` and the content key set is `parts`, `role`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-role-model`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-finish-stop',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'A normal completion finishes with `finishReason` `STOP`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-finish-stop`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-usage-key-set',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'The usageMetadata key set on a minimal text call is `candidatesTokenCount`, `promptTokenCount`, `promptTokensDetails`, `serviceTier`, `totalTokenCount`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-key-set`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-usage-service-tier',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: '`usageMetadata.serviceTier` rides the wire even though the 2.12.0 SDK typings do not declare it',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope (usageServiceTierPresent) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-service-tier`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-modelversion-responseid',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: '`modelVersion` and `responseId` are present nonempty strings; the sandbox mints them deterministically',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-modelversion-responseid`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: 'Synthesized decoration (ruling 2 in packages/conformance/docs/ai/cdd-deltas.md); the values are minted, only presence and determinism are claims.',
  }),
  row({
    rowRef: 'generate-string-request',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'A plain string request is wrapped as a single user turn before it reaches the engine',
    automation: 'unit-backed',
    evidence: '`unit:generate-content.test.ts` test `ai#generate-string-request` (no capture; upstream request formatting claim)',
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-system-instruction',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'A top-level `systemInstruction` is accepted and the response envelope shape is unaffected',
    automation: 'shape-backed',
    evidence: 'Capture ai-system-instruction-accepted replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-system-instruction`',
    observations: ['ai-system-instruction-accepted'],
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-structured-output',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: '`responseMimeType` `application/json` plus a `responseSchema` yields a text part that parses as JSON with the schema key set',
    automation: 'shape-backed',
    evidence: 'Capture ai-structured-output-shape replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-structured-output`',
    observations: ['ai-structured-output-shape'],
    tests: ['generate-content.test.ts'],
    notes: 'The parsed key set is a shape fact; the JSON values are not claims.',
  }),
  row({
    rowRef: 'generate-thinking-signature',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent(request)',
    behavior: 'With `thinkingConfig` on the probe model, text parts carry `thoughtSignature` and no part is flagged `thought: true`',
    automation: 'shape-backed',
    evidence: 'Capture ai-thinking-thought-parts (partKeySets, anyThoughtPart false) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-thinking-signature`',
    observations: ['ai-thinking-thought-parts'],
    tests: ['generate-content.test.ts'],
    notes: 'Lite models return signatures without thought parts; that is the captured fact.',
  }),
  row({
    rowRef: 'generate-abort-signal',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent(request, singleRequestOptions)',
    behavior: 'A pre-aborted `SingleRequestOptions.signal` rejects the call',
    automation: 'unit-backed',
    evidence: '`unit:generate-content.test.ts` test `ai#generate-abort-signal` (no capture; upstream SingleRequestOptions contract)',
    tests: ['generate-content.test.ts'],
  }),
  row({
    rowRef: 'generate-decoration-synthesized',
    featureKeys: ["generateContent"],
    section: SEC_GENERATE,
    api: 'generateContent()',
    behavior: 'Token counts are minted without a tokenizer, and the minimal envelope omits `safetyRatings`, matching the captured candidate key set',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-decoration-synthesized`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['generate-content.test.ts'],
    notes: 'Ruling 2 in packages/conformance/docs/ai/cdd-deltas.md: synthesized decoration is a standing by-design divergence class, documented per row and never hidden.',
  }),
];

// Section: generateContentStream --------------------------------------------

const SEC_STREAM = '`generateContentStream` framing and aggregation';
const streamRows: CompatibilityRow[] = [
  row({
    rowRef: 'stream-async-iterable',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`result.stream` async-iterates response chunks via `for await`; each chunk is a complete GenerateContentResponse',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-stream-framing replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-async-iterable`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
  }),
  row({
    rowRef: 'stream-data-prefixed',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream() wire framing',
    behavior: 'Every SSE event is `data: ` prefixed and its payload parses as a complete JSON document',
    automation: 'oracle-backed',
    evidence: 'Capture ai-generate-stream-framing (allEventsDataPrefixed) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-data-prefixed`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: 'Byte-compared through the framing encoder the scripting module exports, since the SDK-level stream yields parsed objects.',
  }),
  row({
    rowRef: 'stream-separator-crlf',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream() wire framing',
    behavior: 'SSE events are separated by CRLF CRLF',
    automation: 'oracle-backed',
    evidence: 'Capture ai-generate-stream-framing (separatorIsCrlfCrlf) replayed byte-level by packages/pyric/test/ai/streaming.test.ts test `ai#stream-separator-crlf`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
    notes: 'Byte-compared through the framing encoder the scripting module exports.',
  }),
  row({
    rowRef: 'stream-finish-last-chunk',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`finishReason` appears only on the last chunk of a stream',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-stream-framing (finishReasonOnlyOnLastChunk) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-finish-last-chunk`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
  }),
  row({
    rowRef: 'stream-usage-every-chunk',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`usageMetadata` rides every chunk, not only the last one',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-stream-framing (usageMetadataChunkIndexes covers all chunks) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-usage-every-chunk`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
  }),
  row({
    rowRef: 'stream-chunk-envelope',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: 'Every chunk carries `candidates` or `usageMetadata`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-stream-framing (everyEventHasCandidatesOrUsage) replayed by packages/pyric/test/ai/streaming.test.ts test `ai#stream-chunk-envelope`',
    observations: ['ai-generate-stream-framing'],
    tests: ['streaming.test.ts'],
  }),
  row({
    rowRef: 'stream-response-aggregate',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: '`result.response` resolves to an aggregated response whose text is the concatenation of the streamed text parts',
    automation: 'unit-backed',
    evidence: '`unit:streaming.test.ts` test `ai#stream-response-aggregate` (aggregation semantics; text values come from an explicit script)',
    tests: ['streaming.test.ts'],
    notes: 'Text equality is only asserted because the scripted engine was explicitly scripted to return it.',
  }),
  row({
    rowRef: 'stream-aggregate-final-meta',
    featureKeys: ["generateContentStream"],
    section: SEC_STREAM,
    api: 'generateContentStream()',
    behavior: 'The aggregated response carries the final chunk `finishReason` and `usageMetadata`',
    status: 'diverged-documented',
    statusNote: 'metadata carry',
    automation: 'unit-backed',
    evidence: '`unit:streaming.test.ts` test `ai#stream-aggregate-final-meta` (aggregation semantics derived from the framing capture)',
    tests: ['streaming.test.ts'],
    notes: 'Pinned delta vs installed 2.12.0: upstream aggregateResponses drops the final chunk usageMetadata, modelVersion, and responseId on the aggregate; the mirror carries them along (packages/pyric/src/ai/response-helpers.ts).',
  }),
];

// Section: ChatSession -------------------------------------------------------

const SEC_CHAT = '`ChatSession` history and streaming turns';
const chatRows: CompatibilityRow[] = [
  row({
    rowRef: 'chat-startchat',
    featureKeys: ["startChat"],
    section: SEC_CHAT,
    api: 'GenerativeModel.startChat()',
    behavior: '`startChat` returns a `ChatSession` seeded with `StartChatParams.history`',
    automation: 'unit-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I1 validateChatHistory accept/reject via startChat) + `unit:chat-session.test.ts` test `ai#chat-startchat`',
    tests: ['upstream-ai-probes.test.ts', 'chat-session.test.ts'],
  }),
  row({
    rowRef: 'chat-history-threads',
    featureKeys: ["sendMessage","getHistory"],
    section: SEC_CHAT,
    api: 'ChatSession.sendMessage() / getHistory()',
    behavior: '`sendMessage` appends the user turn and the model turn; `getHistory()` returns the ordered `Content[]` with alternating roles',
    status: 'diverged-documented',
    statusNote: 'clone',
    automation: 'unit-backed',
    evidence: '`unit:chat-session.test.ts` test `ai#chat-history-threads` (no capture; history threading claim)',
    tests: ['chat-session.test.ts'],
    notes: 'Pinned delta vs installed 2.12.0: `getHistory()` returns a defensive clone so caller mutations never corrupt the session; the installed SDK hands out its live history array (packages/pyric/src/ai/models.ts).',
  }),
  row({
    rowRef: 'chat-history-excludes-blocked',
    featureKeys: ["getHistory"],
    section: SEC_CHAT,
    api: 'ChatSession.getHistory()',
    behavior: 'Blocked prompts and blocked candidates are excluded from `getHistory()`',
    status: 'diverged-documented',
    statusNote: 'blocked history',
    automation: 'unit-backed',
    evidence: '`unit:chat-session.test.ts` test `ai#chat-history-excludes-blocked` (upstream JSDoc contract; exercised with a scripted blocked envelope)',
    tests: ['chat-session.test.ts'],
    notes: 'Pinned delta vs installed 2.12.0: the mirror implements the documented `getHistory()` contract (blocked prompts are not added to history); the installed implementation appends the user turn unconditionally (packages/pyric/src/ai/models.ts).',
  }),
  row({
    rowRef: 'chat-sendmessage-envelope',
    featureKeys: ["sendMessage"],
    section: SEC_CHAT,
    api: 'ChatSession.sendMessage()',
    behavior: 'A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model`',
    automation: 'shape-backed',
    evidence: 'Capture ai-generate-minimal-envelope replayed by packages/pyric/test/ai/chat-session.test.ts test `ai#chat-sendmessage-envelope`',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['chat-session.test.ts'],
  }),
  row({
    rowRef: 'chat-sendmessagestream',
    featureKeys: ["sendMessageStream"],
    section: SEC_CHAT,
    api: 'ChatSession.sendMessageStream()',
    behavior: '`sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes',
    automation: 'unit-backed',
    evidence: '`unit:chat-session.test.ts` test `ai#chat-sendmessagestream` (no capture; streaming turn claim)',
    tests: ['chat-session.test.ts'],
  }),
  row({
    rowRef: 'chat-stream-single-user-turn',
    featureKeys: ["sendMessageStream"],
    section: SEC_CHAT,
    api: 'ChatSession.sendMessageStream()',
    behavior: 'Exactly one user turn is recorded per `sendMessageStream` call; the mirror implements the 2.13.0 fixed semantics, not the installed 2.12.0 duplicate-user-turn bug',
    status: 'diverged-documented',
    statusNote: '2.13.0 semantics',
    automation: 'unit-backed',
    evidence: '`unit:chat-session.test.ts` test `ai#chat-stream-single-user-turn` (no capture; divergence pinned by ruling, see notes)',
    tests: ['chat-session.test.ts'],
    notes: 'Ruling 3 in packages/conformance/docs/ai/cdd-deltas.md: the installed 2.12.0 duplicates the user turn, fixed upstream in 2.13.0. Reproducing a known upstream bug harms the developer the sandbox exists for, so the mirror ships the fix (packages/pyric/src/ai/models.ts).',
  }),
  row({
    rowRef: 'chat-role-vocabulary',
    featureKeys: ["POSSIBLE_ROLES"],
    section: SEC_CHAT,
    api: 'POSSIBLE_ROLES',
    behavior: '`POSSIBLE_ROLES` is exactly `["user", "model", "function", "system"]`',
    automation: 'unit-backed',
    evidence: '`unit:chat-session.test.ts` test `ai#chat-role-vocabulary` (upstream constant; distinct from the production wire role vocabulary in ai-error-bad-role)',
    tests: ['chat-session.test.ts'],
  }),
];

// Section: function calling --------------------------------------------------

const SEC_FNCALL = 'Function calling';
const fncallRows: CompatibilityRow[] = [
  row({
    rowRef: 'fncall-part-shape',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'functionCall parts',
    behavior: 'A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string',
    automation: 'shape-backed',
    evidence: 'Capture ai-function-call-shape (functionCallKeySet, argsIsObjectNotString) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-part-shape`',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
    notes: 'The parsed-object args shape is the load-bearing difference from OpenAI tool_calls.',
  }),
  row({
    rowRef: 'fncall-mode-any',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'toolConfig.functionCallingConfig',
    behavior: 'Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP`',
    automation: 'shape-backed',
    evidence: 'Capture ai-function-call-shape (captured under mode ANY, finishReason STOP) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-mode-any`',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
  }),
  row({
    rowRef: 'fncall-id-present',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'functionCall parts',
    behavior: '`functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls',
    automation: 'shape-backed',
    evidence: 'Capture ai-function-call-shape (id in functionCallKeySet) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-id-present`',
    observations: ['ai-function-call-shape'],
    tests: ['function-calling.test.ts'],
    notes: 'The upstream JSDoc is self-contradictory about backend id support; the capture is the fact.',
  }),
  row({
    rowRef: 'fncall-round-trip',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'functionResponse round trip',
    behavior: 'A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part',
    automation: 'shape-backed',
    evidence: 'Capture ai-function-response-round replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-round-trip`',
    observations: ['ai-function-response-round'],
    tests: ['function-calling.test.ts'],
  }),
  row({
    rowRef: 'fncall-thought-signature-required',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'functionResponse round trip',
    behavior: 'A replayed model functionCall turn lacking `thoughtSignature` is rejected 400 INVALID_ARGUMENT with the thought-signature message',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-fncall-missing-thought-signature replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-thought-signature-required`',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['function-calling.test.ts'],
    risk: ['error-code', 'specific-value'],
    riskScore: 2,
    riskReasons: ['asserts production error status and message text that can drift on re-capture'],
    notes: 'No SDK typing or reference doc states this requirement; the capture is the only evidence.',
  }),
  row({
    rowRef: 'fncall-signature-minted',
    featureKeys: ["functionCall"],
    section: SEC_FNCALL,
    api: 'scripted engine synthesis',
    behavior: 'The engine mints a `thoughtSignature` on every functionCall part it synthesizes, so scripted tool round trips replay cleanly',
    automation: 'sandbox-only',
    evidence: '`unit:function-calling.test.ts` test `ai#fncall-signature-minted` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['function-calling.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE + ' Ruling 3 of the scripted authoring deltas names this mint.',
  }),
];

// Section: countTokens -------------------------------------------------------

const SEC_COUNT = '`countTokens`';
const countRows: CompatibilityRow[] = [
  row({
    rowRef: 'counttokens-envelope',
    featureKeys: ["countTokens"],
    section: SEC_COUNT,
    api: 'countTokens()',
    behavior: 'The countTokens envelope key set is exactly `promptTokensDetails`, `totalTokens`',
    automation: 'oracle-backed',
    evidence: 'Capture ai-counttokens-envelope replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-envelope`',
    observations: ['ai-counttokens-envelope'],
    tests: ['errors-counttokens.test.ts'],
  }),
  row({
    rowRef: 'counttokens-deterministic',
    featureKeys: ["countTokens"],
    section: SEC_COUNT,
    api: 'countTokens()',
    behavior: 'An identical payload returns an identical `totalTokens` across calls',
    automation: 'oracle-backed',
    evidence: 'Capture ai-counttokens-envelope (deterministicAcrossTwoCalls) replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#counttokens-deterministic`',
    observations: ['ai-counttokens-envelope'],
    tests: ['errors-counttokens.test.ts'],
    notes: 'The sandbox count need not equal the production count; determinism is the claim.',
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
    featureKeys: ["generateContent", "generateContentStream", "countTokens"],
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'A model name production has never served fails 404 NOT_FOUND with the error key set `code`, `message`, `status` and no details',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-unknown-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-unknown-model`',
    observations: ['ai-error-unknown-model'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
  }),
  row({
    rowRef: 'error-retired-model',
    featureKeys: ["generateContent", "generateContentStream", "countTokens"],
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'A retired model family (Gemini 1.5) fails 404 NOT_FOUND with an ErrorInfo detail and a retirement message distinct from unknown-model',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-retired-model replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-retired-model`',
    observations: ['ai-error-retired-model'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: 'Production distinguishes never-existed from retired; the mirror does too.',
  }),
  row({
    rowRef: 'error-bad-api-key',
    featureKeys: ["generateContent", "generateContentStream", "countTokens"],
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An invalid API key fails 400 INVALID_ARGUMENT, not 401, with ErrorInfo plus LocalizedMessage details and the message `API key not valid. Please pass a valid API key.`',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-bad-api-key replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-api-key`',
    observations: ['ai-error-bad-api-key'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: 'detailTypes is a set; the messaging effort found details ordering is not stable.',
  }),
  row({
    rowRef: 'error-empty-contents',
    featureKeys: ["generateContent", "generateContentStream"],
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An empty `contents` array fails 400 INVALID_ARGUMENT with the message `contents is not specified`',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-empty-contents replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-empty-contents`',
    observations: ['ai-error-empty-contents'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
  }),
  row({
    rowRef: 'error-bad-role',
    featureKeys: ["generateContent", "generateContentStream"],
    section: SEC_ERRORS,
    api: 'error envelope',
    behavior: 'An invalid content role fails 400 INVALID_ARGUMENT and the message lists the production role vocabulary: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER',
    automation: 'oracle-backed',
    evidence: 'Capture ai-error-bad-role replayed by packages/pyric/test/ai/errors-counttokens.test.ts test `ai#error-bad-role`',
    observations: ['ai-error-bad-role'],
    tests: ['errors-counttokens.test.ts'],
    ...ERROR_RISK,
    notes: 'The wire role vocabulary is wider than the SDK POSSIBLE_ROLES constant.',
  }),
  row({
    rowRef: 'error-aierror-shape',
    featureKeys: ["AIError","AIErrorCode"],
    section: SEC_ERRORS,
    api: 'AIError',
    behavior: 'HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails`',
    automation: 'unit-backed',
    evidence: '`unit:errors-counttokens.test.ts` test `ai#error-aierror-shape` (capture ai-error-bad-api-key cited as the sample envelope)',
    observations: ['ai-error-bad-api-key'],
    tests: ['errors-counttokens.test.ts'],
    notes: 'The client-side error class shape wraps the oracle-backed wire envelope.',
  }),
  row({
    rowRef: 'error-code-vocabulary',
    featureKeys: ["AIErrorCode"],
    section: SEC_ERRORS,
    api: 'AIErrorCode',
    behavior: '`AIErrorCode` exposes the 14 documented codes, from `error` through `unsupported`',
    automation: 'unit-backed',
    evidence: '`unit:errors-counttokens.test.ts` test `ai#error-code-vocabulary` (upstream constant vocabulary)',
    tests: ['errors-counttokens.test.ts'],
  }),
];

// Section: response helpers ----------------------------------------------------

const SEC_HELPERS = 'Response helpers (`EnhancedGenerateContentResponse`)';
const helperRows: CompatibilityRow[] = [
  row({
    rowRef: 'helper-text',
    featureKeys: ["text"],
    section: SEC_HELPERS,
    api: 'response.text()',
    behavior: '`text()` concatenates the text parts of the first candidate',
    automation: 'unit-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I3 text() across mixed parts) + `unit:helpers-schema.test.ts` test `ai#helper-text`',
    tests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'helper-text-throws',
    featureKeys: ["text"],
    section: SEC_HELPERS,
    api: 'response.text()',
    behavior: '`text()` throws on bad finish reasons such as `SAFETY` and on a blocked prompt',
    automation: 'unit-backed',
    evidence: '`unit:helpers-schema.test.ts` test `ai#helper-text-throws` (exercised with a scripted SAFETY envelope)',
    tests: ['helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'helper-functioncalls',
    featureKeys: ["functionCalls"],
    section: SEC_HELPERS,
    api: 'response.functionCalls()',
    behavior: '`functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects',
    automation: 'shape-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I3 text+functionCall mix) + Capture ai-function-call-shape replayed by `unit:helpers-schema.test.ts` test `ai#helper-functioncalls`',
    observations: ['ai-function-call-shape'],
    tests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'helper-thoughtsummary',
    featureKeys: ["thoughtSummary"],
    section: SEC_HELPERS,
    api: 'response.thoughtSummary()',
    behavior: '`thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case',
    automation: 'shape-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I3 thoughtSummary from thought parts) + Capture ai-thinking-thought-parts replayed by `unit:helpers-schema.test.ts` test `ai#helper-thoughtsummary`',
    observations: ['ai-thinking-thought-parts'],
    tests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'helper-inlinedataparts',
    featureKeys: ["inlineDataParts"],
    section: SEC_HELPERS,
    api: 'response.inlineDataParts()',
    behavior: '`inlineDataParts()` returns the `InlineDataPart` array when inlineData parts exist and undefined when none do',
    automation: 'unit-backed',
    evidence: '`unit:helpers-schema.test.ts` test `ai#helper-inlinedataparts` (exercised with a scripted raw envelope)',
    tests: ['helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'helper-tolerates-missing-decor',
    featureKeys: ["text"],
    section: SEC_HELPERS,
    api: 'response helpers',
    behavior: 'Helpers tolerate omitted decoration: an envelope without `usageMetadata`, `finishReason`, or `safetyRatings` still serves `text()` without throwing',
    automation: 'unit-backed',
    evidence: '`unit:helpers-schema.test.ts` test `ai#helper-tolerates-missing-decor` (exercised with a scripted bare envelope)',
    tests: ['helpers-schema.test.ts'],
  }),
];

// Section: Schema builders ----------------------------------------------------

const SEC_SCHEMA = '`Schema` builders';
const schemaRows: CompatibilityRow[] = [
  row({
    rowRef: 'schema-object-tojson',
    featureKeys: ["Schema"],
    section: SEC_SCHEMA,
    api: 'Schema.object()',
    behavior: '`Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties`',
    automation: 'unit-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I2 empty optionalProperties + propertyOrdering) + `unit:helpers-schema.test.ts` test `ai#schema-object-tojson`',
    tests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'schema-string-enum',
    featureKeys: ["Schema"],
    section: SEC_SCHEMA,
    api: 'Schema.enumString()',
    behavior: '`Schema.enumString` serializes the enum values with type `string` and format `enum`',
    status: 'diverged-documented',
    statusNote: 'format',
    automation: 'unit-backed',
    evidence: '`unit:helpers-schema.test.ts` test `ai#schema-string-enum` (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats)',
    tests: ['helpers-schema.test.ts'],
    notes: 'Pinned delta vs installed 2.12.0: the installed enumString omits `format`; GoogleAI accepts only the enum and date-time formats, so the mirror serializes format `enum` (packages/pyric/src/ai/schema.ts).',
  }),
  row({
    rowRef: 'schema-primitives',
    featureKeys: ["Schema"],
    section: SEC_SCHEMA,
    api: 'Schema.string()/integer()/number()/boolean()/array()',
    behavior: 'Each primitive builder serializes its `SchemaType`, and `array` carries `items`',
    automation: 'unit-backed',
    evidence: '`unit:helpers-schema.test.ts` test `ai#schema-primitives` (upstream toJSON request shape)',
    tests: ['helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'schema-anyof',
    featureKeys: ["Schema"],
    section: SEC_SCHEMA,
    api: 'Schema.anyOf()',
    behavior: '`Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type',
    automation: 'unit-backed',
    evidence: '`unit:upstream-ai-probes.test.ts` (I2 empty anyOf → invalid-schema) + `unit:helpers-schema.test.ts` test `ai#schema-anyof`',
    tests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  }),
  row({
    rowRef: 'schema-rides-request',
    featureKeys: ["Schema"],
    section: SEC_SCHEMA,
    api: 'generationConfig.responseSchema',
    behavior: 'A built `Schema` serializes into `generationConfig.responseSchema` on the request and drives JSON output',
    automation: 'shape-backed',
    evidence: 'Capture ai-structured-output-shape replayed by packages/pyric/test/ai/helpers-schema.test.ts test `ai#schema-rides-request`',
    observations: ['ai-structured-output-shape'],
    tests: ['helpers-schema.test.ts'],
  }),
];

// Section: scripted engine -----------------------------------------------------

const SEC_SCRIPTED = 'Sandbox answer engine: scripted';
const scriptedRows: CompatibilityRow[] = [
  row({
    rowRef: 'scripted-zero-config',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'scripted engine',
    behavior: 'With no script the engine returns a deterministic synthesized response derived from the request, wire-true in shape: the captured envelope key sets hold',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-zero-config` (capture ai-generate-minimal-envelope cited as the shape source)',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE + ' Ruling 1 of the scripted authoring deltas: tests and demos never hang on missing setup.',
  }),
  row({
    rowRef: 'scripted-deterministic',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'scripted engine',
    behavior: 'The same unscripted request twice yields an identical envelope, candidates and usage included',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-deterministic` (determinism claim from the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-queue-order',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Script entries without matchers are consumed in FIFO queue order',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-queue-order` (ruling 2 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-matchers',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Entries match by substring, regex, or predicate on the request; a matching entry wins over the plain queue',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-matchers` (ruling 2 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-raw-envelope',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A raw Gemini envelope entry is returned verbatim, so an observation `behavior.raw` pastes in directly and captures are the corpus',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-raw-envelope` (ruling 3 of the scripted authoring deltas)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-shorthand-text',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A `text` shorthand expands to a wire-true envelope: finishReason STOP, usageMetadata with serviceTier, modelVersion, responseId',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-shorthand-text` (capture ai-generate-minimal-envelope cited as the expansion target)',
    observations: ['ai-generate-minimal-envelope'],
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE + ' One synthesizer owns the shape facts (ruling 3 of the scripted authoring deltas).',
  }),
  row({
    rowRef: 'scripted-shorthand-functioncall',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A `functionCall` shorthand expands to a model turn whose functionCall part carries a minted `thoughtSignature`',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-shorthand-functioncall` (capture ai-error-fncall-missing-thought-signature cited as the motivating rejection)',
    observations: ['ai-error-fncall-missing-thought-signature'],
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'scripted-stream-chunks',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'A chunk-array shorthand declares chunk boundaries and the engine applies the captured framing, so authors never hand-write SSE',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-stream-chunks` (capture ai-generate-stream-framing cited as the framing source)',
    observations: ['ai-generate-stream-framing'],
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE + ' Ruling 4 of the scripted authoring deltas.',
  }),
  row({
    rowRef: 'scripted-text-assertable',
    featureKeys: ["script"],
    section: SEC_SCRIPTED,
    api: 'script(ai, entries)',
    behavior: 'Scripted text is the one place generated text values may be asserted: `response.text()` returns the scripted string exactly',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#scripted-text-assertable` (evidence tier ruling 1: generated text is never compared anywhere else)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
];

// Section: openai engine -------------------------------------------------------

const SEC_OPENAI = 'Sandbox answer engine: openai translation';
const openaiRows: CompatibilityRow[] = [
  row({
    rowRef: 'openai-request-translation',
    featureKeys: [],
    queryable: false,
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Gemini `contents` and `systemInstruction` translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role `model`',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#openai-request-translation` (translation exercised against a local OpenAI-compatible mock)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-fifo-tool-ids',
    featureKeys: [],
    queryable: false,
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'OpenAI `tool_call` ids are matched FIFO against Gemini functionResponse parts when replaying tool history',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#openai-fifo-tool-ids` (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE + ' Documented lossy edge: Gemini ids are optional, so ordering is the join key.',
  }),
  row({
    rowRef: 'openai-buffered-fncalls',
    featureKeys: [],
    queryable: false,
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#openai-buffered-fncalls` (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-done-not-forwarded',
    featureKeys: [],
    queryable: false,
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'The OpenAI `[DONE]` sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#openai-done-not-forwarded` (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
  row({
    rowRef: 'openai-thought-parts-skipped',
    featureKeys: [],
    queryable: false,
    section: SEC_OPENAI,
    api: 'openai engine',
    behavior: 'Parts flagged `thought: true` in history are skipped when replaying to an OpenAI upstream',
    automation: 'sandbox-only',
    evidence: '`unit:engines.test.ts` test `ai#openai-thought-parts-skipped` (lossy translation edge from ticket #96)',
    tests: ['engines.test.ts'],
    exceptionReason: ENGINE_EXCEPTION,
    notes: ENGINE_NOTE,
  }),
];

// Doc assembly -------------------------------------------------------------

const header = `# \`pyric/ai\` compatibility matrix

This surface climbed under Conformance Driven Development
(map: https://github.com/davideast/pyric/issues/92). Every row below was
born \`unverified\` at admission: the row universe and the red conformance
suites came first, the mirror implementation came after. All 78 rows are
now flipped: the climb lane (\`bun run compat:climb-ai\`, the suites at
\`packages/pyric/test/ai\`) passes 78 of 78 with no assertion
weakened, and every row records the tier of evidence that vouches for it.

Evidence tiers per \`packages/conformance/docs/ai/cdd-deltas.md\`:

- \`oracle-backed\` (10 rows): the suite replays value-deterministic facts
  from a cited observation (error envelopes, countTokens, byte-compared
  stream framing, the thought-signature rejection).
- \`shape-backed\` (23 rows): the suite replays an observation's distilled
  shape facts (key sets, enum values, streaming semantics); values are
  nondeterministic in production.
- \`unit-backed\` (28 rows): SDK mechanics with no vouching observation
  (dispatch, ChatSession behavior, Schema builders, response helpers).
- \`sandbox-only\` (17 rows): the answer-engine seam, which has no
  production analogue.

72 rows conform; 6 are documented divergences from the installed
firebase/ai 2.12.0, each with the reason pinned in its notes.

Generated-content VALUES are never claims. Production output is
nondeterministic, so no row asserts on generated text, and the suites only
compare text when the scripted engine was explicitly scripted to return it
(the shape-backed tier ruling in \`packages/conformance/docs/ai/cdd-deltas.md\`).

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match prod but doesn't; failing probe pins it |
| — | **Unsupported**: not implemented yet (deliberately or pending) |
| ? | **Unverified**: claim not yet locked by a passing probe |

Probe references: \`unit:<file>\` means a passing Bun test in
\`packages/pyric/test/ai/<file>\` (the climb lane). Captures live at
\`packages/conformance/observations/ai/ai-*.json\`; a row that cites one replays the
capture's distilled facts in the named test.

---
`;

function table(title: string, rows: CompatibilityRow[]): CompatibilityDocBlock {
  return { kind: 'table', prefix: `## ${title}\n`, rows };
}

export const aiRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai',
  label: 'AI Logic',
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
  ],
};
