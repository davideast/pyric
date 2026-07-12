# Ticket #94 Resolution: Public surface of firebase/ai (from installed packages), with V1 marks and draft denylist

## Provenance

Enumerated from the packages installed in this repo, not from upstream source.

- `firebase@12.13.0` re-exports the bundled `@firebase/ai@2.12.0`. The `firebase/ai` entry is a thin shim: `node_modules/firebase/ai/dist/ai/index.d.ts` is a single `export * from '@firebase/ai'`. The real typings resolve to `node_modules/.bun/@firebase+ai@2.12.0+cb573f7af8d74f46/node_modules/@firebase/ai/dist/ai-public.d.ts` (4048 lines). Runtime bundles live next to it (`index.node.cjs.js`, `index.cjs.js`, `esm/index.esm.js`).
- Runtime value exports were verified by loading `dist/index.node.cjs.js` and enumerating `Object.keys`: 55 names, matching the pre-enumerated list exactly. Everything else in `ai-public.d.ts` is a type-only export.
- Total public export names in 2.12.0: 171. That is 170 declared names plus the aliased `Date` (`declare interface Date_2` re-exported as `Date`). Names marked "Excluded from this release type" in the typings (`_apiSettings`, `WebSocketHandler`, `_LiveClientSetup`, the `GoogleAI*` wire types, and similar) are not public exports and are not counted.
- Behavior claims below are one-liners paraphrased from the JSDoc in `ai-public.d.ts`. Almost none of them are evidenced yet. The evidence that exists so far comes from the ticket #93 probe (https://github.com/davideast/pyric/issues/93), noted inline as **Evidenced**:
  - One real `generateContent` call succeeded end to end against the GoogleAI backend on `gemini-flash-lite-latest` (evidences `getAI`, `getGenerativeModel`, `GenerativeModel.generateContent`, and the basic `GenerateContentResult`/`UsageMetadata` shape).
  - `usageMetadata.serviceTier` was observed on the wire 2026-07-09 but is absent from the typings (both 2.12.0 installed and the 2.13.1 clone). The mirror's row universe for `UsageMetadata` must account for this extra wire field.
  - `inferenceSource` and candidate `index` are added client-side by the SDK, not by the server. Capture rigs must freeze raw wire bytes at the fetch layer.
  - Error envelope fact: with App Check enforced, every tokenless request 401s with "Firebase App Check token is invalid". No AIError-shaped client error has been captured yet.

## Version skew: vendored clone is 2.13.1, installed is 2.12.0

The vendored clone at `clones/firebase-js-sdk/packages/ai` is version 2.13.1, newer than the installed 2.12.0. The census gate runs against installed, so 2.12.0 is the universe. Present in 2.13.1 but not in 2.12.0 (diff of the export sets, clone `common/api-review/ai.api.md` vs installed `ai-public.d.ts`):

- New export names (10), none of which change the V1 plane: `GoogleAICitationMetadata`, `GoogleAICountTokensRequest`, `GoogleAIGenerateContentCandidate`, `GoogleAIGenerateContentResponse`, `TemplateFunctionDeclarationInternal`, `TemplateFunctionDeclarationsToolInternal`, `TemplateGenerateContentRequest`, `TemplateRequestInternal` (all marked `@internal` in the api report; they exist in 2.12.0 too but are excluded from its release types), plus `LanguageModelDownloadMonitor` and `LanguageModelExpected` (hybrid on-device types; `LanguageModelExpected` is already public in 2.12.0, the api report also surfaces the download monitor).
- New members and behavior in 2.13.x per the changelog: `GenerativeModel.initializeDeviceModel(onDownloadProgress?)` (2.13.0, hybrid mode), hybrid inference features retagged from public preview to generally available (2.13.0), a fix so `sendMessageStream` no longer sends duplicate user turns (2.13.0), `GoogleMaps.enableWidget` deprecated (2.13.1), and `ChatSession` now wraps `params.systemInstruction` with `formatSystemInstruction()` in its constructor (2.13.1, meaning the installed 2.12.0 does NOT normalize string system instructions in the ChatSession constructor).
- Nothing was removed between 2.12.0 and 2.13.1.
- `usageMetadata.serviceTier` is absent from both versions' typings despite appearing on the wire.

## Classification key

Marks follow the V1 scope line from map #92. "v1" means the export is part of the mirrored core REST plane. "deny" means intentionally not mirrored, with the reason stated. Four deny groups: Imagen (deprecated upstream, models shut down as early as June 2026), Live API (separate bidirectional websocket protocol, public preview), server-side templates (public preview, depends on server-stored templates), and hybrid/on-device (depends on Chrome `window.LanguageModel`, browser-only).

---

## Entry point and service: mark v1

- `getAI(app?: FirebaseApp, options?: AIOptions): AI` - v1 - returns the default AI instance for the app, initializing with default settings (GoogleAIBackend) if none exists. **Evidenced** by the #93 probe.
- `interface AI { app; backend; options?; location (deprecated) }` - v1 - an instance of the Firebase AI SDK; do not construct directly.
- `interface AIOptions { backend?: Backend; useLimitedUseAppCheckTokens?: boolean }` - v1 - initialization options; backend defaults to the Gemini Developer API.
- `abstract class Backend { readonly backendType: BackendType }` - v1 - abstract base for backend configuration; use the subclasses.
- `const/type BackendType` (`VERTEX_AI`, `GOOGLE_AI`) - v1 - identifies which backend service the SDK communicates with.
- `class GoogleAIBackend extends Backend` - v1 - configuration object for the Gemini Developer API backend. **Evidenced** (the #93 probe ran on this backend).
- `class VertexAIBackend extends Backend { readonly location: string }` - v1 - configuration for the Vertex AI Gemini API; location defaults to `us-central1`.

## Errors: mark v1

- `class AIError extends FirebaseError { code: AIErrorCode; customErrorData? }` - v1 - error class for the SDK.
- `const/type AIErrorCode` - v1 - 14 codes: `error`, `request-error`, `response-error`, `fetch-error`, `session-closed`, `invalid-content`, `api-not-enabled`, `invalid-schema`, `no-api-key`, `no-app-id`, `no-model`, `no-project-id`, `parse-failed`, `unsupported`.
- `interface CustomErrorData { status?; statusText?; response?; errorDetails? }` - v1 - data from a bad HTTP response.
- `interface ErrorDetails { '@type'?; reason?; domain?; metadata?; [key: string]: unknown }` - v1 - details object in an error response. Partially informed by #93: App Check enforcement produces a 401 "Firebase App Check token is invalid" before any AIError shape is reached.

## Model plane: mark v1

- `getGenerativeModel(ai: AI, modelParams: ModelParams | HybridParams, requestOptions?): GenerativeModel` - v1 - returns a GenerativeModel with inference methods. **Evidenced** by the #93 probe. Note: the `HybridParams` overload is hybrid/on-device and is denied; the mirror admits the `ModelParams` form only.
- `class GenerativeModel extends AIModel` - v1 - class for generative model APIs. Members: `generationConfig`, `safetySettings`, `requestOptions?`, `tools?`, `toolConfig?`, `systemInstruction?`.
  - `generateContent(request, singleRequestOptions?): Promise<GenerateContentResult>` - single non-streaming call. **Evidenced** by the #93 probe (returned the requested word, 11 tokens total, on `gemini-flash-lite-latest`; model naming is volatile, `-latest` aliases resolve).
  - `generateContentStream(request, singleRequestOptions?): Promise<GenerateContentStreamResult>` - single streaming call returning an iterable stream plus an aggregated-response promise.
  - `startChat(startChatParams?): ChatSession` - returns a new ChatSession for multi-turn chat.
  - `countTokens(request, singleRequestOptions?): Promise<CountTokensResponse>` - counts the tokens in the provided request.
- `abstract class AIModel { readonly model: string }` - v1 - base class for model APIs; holds the fully qualified model resource name.
- `class ChatSession extends ChatSessionBase<StartChatParams, GenerateContentRequest, FunctionDeclarationsTool>` - v1 - sends chat messages and stores history.
  - `sendMessage(request, singleRequestOptions?): Promise<GenerateContentResult>` - non-streaming chat turn.
  - `sendMessageStream(request, singleRequestOptions?): Promise<GenerateContentStreamResult>` - streaming chat turn. Version-skew note: 2.13.0 fixed duplicate user turns in the request; the installed 2.12.0 has that bug.
- `abstract class ChatSessionBase<ParamsType, RequestType, FunctionDeclarationsToolType>` - v1 - base class for chat sessions; `getHistory(): Promise<Content[]>` returns history so far, with blocked prompts and blocked candidates excluded. Note: its generic bounds reference `StartTemplateChatParams` and `TemplateFunctionDeclarationsTool`, which are denied exports; the type parameter bounds ride along as text but the template instantiation is not mirrored.
- `const POSSIBLE_ROLES = ['user', 'model', 'function', 'system']` - v1 - possible roles.
- `type Role = (typeof POSSIBLE_ROLES)[number]` - v1 - the producer of the content.

## Request and response types: mark v1

- `interface BaseParams { safetySettings?; generationConfig? }` - v1 - base parameters shared by several methods.
- `interface ModelParams extends BaseParams { model; tools?; toolConfig?; systemInstruction? }` - v1 - params for getGenerativeModel.
- `interface StartChatParams extends BaseParams { history?; tools?; toolConfig?; systemInstruction? }` - v1 - params for startChat.
- `interface GenerateContentRequest extends BaseParams { contents; tools?; toolConfig?; systemInstruction? }` - v1 - request sent through generateContent.
- `interface GenerateContentResult { response: EnhancedGenerateContentResponse }` - v1 - result of a generateContent call.
- `interface GenerateContentStreamResult { stream: AsyncGenerator<EnhancedGenerateContentResponse>; response: Promise<...> }` - v1 - iterate the stream for chunks, await response for the aggregate.
- `interface GenerateContentResponse { candidates?; promptFeedback?; usageMetadata? }` - v1 - individual response; streaming returns one per chunk.
- `interface EnhancedGenerateContentResponse extends GenerateContentResponse` - v1 - response wrapped with helpers: `text()` (throws if the prompt or candidate was blocked), `inlineDataParts()`, `functionCalls()`, `thoughtSummary()`. Its optional `inferenceSource?` property belongs to the denied hybrid feature; per #93 it is added client-side by the SDK and never appears on the wire, so the mirror's REST plane never produces it.
- `interface GenerateContentCandidate { index; content; finishReason?; finishMessage?; safetyRatings?; citationMetadata?; groundingMetadata?; urlContextMetadata? }` - v1 - a candidate in a response. Per #93, `index` is added client-side by the SDK; raw wire bytes may omit it.
- `interface CountTokensRequest { contents; systemInstruction?; tools?; generationConfig? }` - v1 - params for countTokens.
- `interface CountTokensResponse { totalTokens; totalBillableCharacters? (deprecated); promptTokensDetails? }` - v1 - response from countTokens.
- `interface PromptFeedback { blockReason?; safetyRatings; blockReasonMessage? }` - v1 - populated when the prompt was blocked; `blockReasonMessage` is Vertex AI only.
- `interface UsageMetadata { promptTokenCount; candidatesTokenCount; thoughtsTokenCount?; totalTokenCount; toolUsePromptTokenCount?; promptTokensDetails?; candidatesTokensDetails?; toolUsePromptTokensDetails?; cachedContentTokenCount?; cacheTokensDetails? }` - v1 - usage metadata about a response. **Evidenced**: on the wire 2026-07-09 the server also sent `serviceTier`, which is absent from the typings; the mirror's row universe must carry this untyped field.
- `interface ModalityTokenCount { modality; tokenCount }` - v1 - token counting info for a single modality.
- `const/type Modality` (`MODALITY_UNSPECIFIED`, `TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`) - v1 - content part modality.
- `interface GenerationConfig` - v1 - config for content requests: `candidateCount?`, `stopSequences?`, `maxOutputTokens?`, `temperature?`, `topP?`, `topK?`, `presencePenalty?`, `frequencyPenalty?`, `responseMimeType?`, `responseSchema?`, `responseJsonSchema?`, `responseModalities?`, `thinkingConfig?`, `imageConfig?`.
- `interface RequestOptions { timeout? (default 180000ms); baseUrl? (default https://firebasevertexai.googleapis.com); maxSequentialFunctionCalls? (default 10) }` - v1 - per-model request options.
- `interface SingleRequestOptions extends RequestOptions { signal?: AbortSignal }` - v1 - per-request options; abort cancels the HTTP request but not backend billing.
- `const/type FinishReason` - v1 - 19 values: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_OTHER`, `NO_IMAGE`, `IMAGE_RECITATION`, `LANGUAGE`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`, `MALFORMED_RESPONSE`.
- `const/type BlockReason` (`SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`) - v1 - reason a prompt was blocked.
- `interface Citation { startIndex?; endIndex?; uri?; license?; title?; publicationDate? }` - v1 - a single citation; title and publicationDate are Vertex AI only.
- `interface CitationMetadata { citations: Citation[] }` - v1 - citation metadata on a candidate.
- `interface Date { year; month; day }` (aliased from `Date_2`) - v1 - protobuf google.type.Date, rides Citation.publicationDate.

## Content and parts: mark v1

- `interface Content { role: Role; parts: Part[] }` - v1 - content type for prompts and candidates.
- `type Part = TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart | FileDataPart | ExecutableCodePart | CodeExecutionResultPart` - v1 - the part union.
- `interface TextPart { text: string; thought?: boolean }` - v1 - text part.
- `interface InlineDataPart { inlineData: GenerativeContentBlob; videoMetadata?; thought? }` - v1 - image or media part; videoMetadata applies when inlineData is video.
- `interface GenerativeContentBlob { mimeType; data }` - v1 - media as a base64 string.
- `interface VideoMetadata { startOffset; endOffset }` - v1 - input video offsets in protobuf Duration format.
- `interface FileData { mimeType; fileUri }` - v1 - data pointing to a file uploaded to Google Cloud Storage.
- `interface FileDataPart { fileData: FileData; thought? }` - v1 (borderline call, see below) - part referencing a Cloud Storage file. The type ships in v1 because it is a member of the `Part` union and rides `generateContent`; behavior caveat: the pyric sandbox cannot fetch remote Cloud Storage URIs, so a mirrored backend will reject or ignore the referenced bytes rather than resolve them.
- `interface FunctionCallPart { functionCall: FunctionCall; thought? }` - v1 - part carrying a model function call.
- `interface FunctionResponsePart { functionResponse: FunctionResponse; thought? }` - v1 - part carrying a client function response.
- `interface ExecutableCodePart { executableCode?: ExecutableCode }` - v1 - the code the model executed (rides the code execution tool).
- `interface CodeExecutionResultPart { codeExecutionResult?: CodeExecutionResult }` - v1 - the result of that execution.
- `interface ExecutableCode { language?: Language; code?: string }` - v1 - executable code returned by the model.
- `interface CodeExecutionResult { outcome?: Outcome; output?: string }` - v1 - result of code the model ran.
- `const/type Language` (`UNSPECIFIED`, `PYTHON`) - v1 - programming language of the code.
- `const/type Outcome` (`UNSPECIFIED`, `OK`, `FAILED`, `DEADLINE_EXCEEDED`) - v1 - result of the code execution.

## Function calling: mark v1

- `interface FunctionDeclaration { name; description; parameters?; functionReference? }` - v1 - OpenAPI-style declaration of a callable function; `functionReference` triggers automatic calling by the SDK.
- `interface FunctionDeclarationsTool { functionDeclarations? }` - v1 - up to 64 function declarations passed with the query.
- `interface FunctionCall { id?; name; args }` - v1 - a predicted function call from the model; `id` support differs by backend per the JSDoc (the JSDoc remark is self-contradictory about which backend omits it; wire evidence needed).
- `interface FunctionResponse { id?; name; response; parts? }` - v1 - the result of a function call, used as context by the model.
- `interface FunctionCallingConfig { mode?; allowedFunctionNames? }` - v1 - constrains how the model may call functions.
- `const/type FunctionCallingMode` (`AUTO`, `ANY`, `NONE`) - v1 - default, forced call, or no calls.
- `type Tool = FunctionDeclarationsTool | GoogleMapsTool | GoogleSearchTool | CodeExecutionTool | URLContextTool` - v1 - the tool union.
- `interface ToolConfig { functionCallingConfig?; retrievalConfig? }` - v1 - config shared by all tools in a request.
- `interface RetrievalConfig { latLng?; languageCode? }` - v1 - user location and language for retrieval tools; rides ToolConfig.
- `interface LatLng { latitude?; longitude? }` - v1 - latitude/longitude pair.

## Schema builder: mark v1

- `abstract class Schema` - v1 - parent of all schema types; static builders `array`, `object`, `string`, `enumString`, `integer`, `number`, `boolean`, `anyOf`; serializes with JSON.stringify into what the REST endpoints accept.
- `class AnyOfSchema extends Schema { anyOf: TypedSchema[] }` - v1 - value conforming to any of the sub-schemas.
- `class ArraySchema extends Schema { items: TypedSchema }` - v1 - array type.
- `class BooleanSchema extends Schema` - v1 - boolean type.
- `class IntegerSchema extends Schema` - v1 - integer type.
- `class NumberSchema extends Schema` - v1 - number type.
- `class ObjectSchema extends Schema { properties; optionalProperties }` - v1 - object type; properties is a map of Schema objects.
- `class StringSchema extends Schema { enum? }` - v1 - string type, with or without enum values.
- `type TypedSchema` - v1 - union of all specific schema classes.
- `interface SchemaInterface extends SchemaShared<SchemaInterface> { type? }` - v1 - interface of the Schema class.
- `interface SchemaParams extends SchemaShared<SchemaInterface>` - v1 - params for the static builders.
- `interface SchemaRequest extends SchemaShared<SchemaRequest> { type?; required? }` - v1 - final wire format for schema params.
- `interface SchemaShared<T>` - v1 - shared schema properties (`anyOf`, `format`, `description`, `title`, `items`, `minItems`, `maxItems`, `properties`, `propertyOrdering`, `enum`, `example`, `nullable`, `minimum`, `maximum`, open index signature). JSDoc claim: on GoogleAI, `format` must be `'enum'` or `'date-time'` or requests fail.
- `interface ObjectSchemaRequest extends SchemaRequest { type: 'object'; optionalProperties?: never }` - v1 - plain-object variant for function parameters.
- `const/type SchemaType` (`string`, `number`, `integer`, `boolean`, `array`, `object`) - v1 - OpenAPI data types.

## Safety: mark v1

- `interface SafetySetting { category; threshold; method? }` - v1 - request safety setting; `method` is Vertex AI only, an AIError is thrown if defined on GoogleAI.
- `interface SafetyRating { category; probability; severity; probabilityScore; severityScore; blocked }` - v1 - rating on a candidate; severity and the score fields are Vertex AI only, defaulting to `HARM_SEVERITY_UNSUPPORTED` and 0 on GoogleAI.
- `const/type HarmCategory` (`HARM_CATEGORY_HATE_SPEECH`, `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_HARASSMENT`, `HARM_CATEGORY_DANGEROUS_CONTENT`) - v1 - rides SafetySetting.
- `const/type HarmBlockThreshold` (`BLOCK_LOW_AND_ABOVE`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_ONLY_HIGH`, `BLOCK_NONE`, `OFF`) - v1 - threshold above which content is blocked.
- `const/type HarmBlockMethod` (`SEVERITY`, `PROBABILITY`) - v1 - not supported on GoogleAI per JSDoc; rides SafetySetting.method.
- `const/type HarmProbability` (`NEGLIGIBLE`, `LOW`, `MEDIUM`, `HIGH`) - v1 - probability a prompt or candidate matches a harm category.
- `const/type HarmSeverity` (`HARM_SEVERITY_NEGLIGIBLE`, `HARM_SEVERITY_LOW`, `HARM_SEVERITY_MEDIUM`, `HARM_SEVERITY_HIGH`, `HARM_SEVERITY_UNSUPPORTED`) - v1 - severity levels; `UNSUPPORTED` is the GoogleAI fallback.

## Grounding and URL context: mark v1 (types ride the Tool union and the candidate response)

- `interface GoogleSearchTool { googleSearch: GoogleSearch }` - v1 - lets the model ground on Google Search; usage requirements apply per provider terms.
- `interface GoogleSearch {}` - v1 - empty config object, reserved for future options.
- `interface GoogleMapsTool { googleMaps: GoogleMaps }` - v1 - lets the model ground on Google Maps; provider terms apply.
- `interface GoogleMaps { enableWidget? }` - v1 - Maps config. Version-skew note: `enableWidget` is deprecated in 2.13.1 following the service announcement.
- `interface CodeExecutionTool { codeExecution: {} }` - v1 - enables model-side code execution; config object currently empty.
- `interface URLContextTool { urlContext: URLContext }` - v1 - provides public web URLs as context to the model.
- `interface URLContext {}` - v1 - empty config object.
- `interface URLContextMetadata { urlMetadata: URLMetadata[] }` - v1 - rides the candidate response.
- `interface URLMetadata { retrievedUrl?; urlRetrievalStatus? }` - v1 - metadata for a single retrieved URL.
- `const/type URLRetrievalStatus` (`URL_RETRIEVAL_STATUS_UNSPECIFIED`, `_SUCCESS`, `_ERROR`, `_PAYWALL`, `_UNSAFE`) - v1 - status of a URL retrieval.
- `interface GroundingMetadata { searchEntryPoint?; groundingChunks?; groundingSupports?; webSearchQueries?; retrievalQueries? (deprecated); googleMapsWidgetContextToken? }` - v1 - returned when grounding is enabled.
- `interface GroundingChunk { web?; maps? }` - v1 - a retrieved chunk supporting a claim.
- `interface WebGroundingChunk { uri?; title?; domain? }` - v1 - web source details; `domain` is Vertex AI only.
- `interface GoogleMapsGroundingChunk { uri?; title?; text?; placeId? }` - v1 - Maps source details.
- `interface GroundingSupport { segment?; groundingChunkIndices? }` - v1 - ties response segments to grounding chunks.
- `interface Segment { partIndex; startIndex; endIndex; text }` - v1 - pinpoints a span within a Part, offsets in UTF-8 bytes.
- `interface SearchEntrypoint { renderedContent? }` - v1 - HTML/CSS snippet that must be embedded to display the search entry point.

Behavior caveat for the whole group: the sandbox cannot perform live Google Search, Maps, URL retrieval, or code execution. The types are admitted because they ride the `Tool` union and `GenerateContentCandidate` on `generateContent`; what a mirrored backend does when these tools are requested is a behavior question for the oracle, not a surface question.

## Thinking and Gemini image config: mark v1

- `interface ThinkingConfig { thinkingBudget?; thinkingLevel?; includeThoughts? }` - v1 - thinking behavior for compatible models; the model errors if both budget and level are set, or if a budget is set on a model that does not support it.
- `const/type ThinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) - v1 - preset controlling the thinking process; Gemini 2.5 series does not support levels per JSDoc.
- `interface ImageConfig { aspectRatio?; imageSize? }` - v1 - image generation options for Gemini models (not Imagen); rides GenerationConfig.imageConfig.
- `const/type ImageConfigAspectRatio` (14 ratios from `1:1` to `21:9`) - v1 - aspect ratios for generated images.
- `const/type ImageConfigImageSize` (`512`, `1K`, `2K`, `4K`) - v1 - sizes for generated images.
- `const/type ResponseModality` (`TEXT`, `IMAGE`, `AUDIO`) - v1 - generation modalities in responses; marked `@beta` upstream but rides GenerationConfig.responseModalities on the core plane.

---

## Denied: Imagen (deprecated upstream; all Imagen models shut down as early as June 2026)

- `getImagenModel(ai, modelParams, requestOptions?): ImagenModel` - deny - returns an ImagenModel; only `imagen-3.0-*` supported; `@deprecated`.
- `class ImagenModel extends AIModel` - deny - `generateImages(prompt, singleRequestOptions?)` returns base64 images; `@deprecated`.
- `getTemplateImagenModel(ai, requestOptions?): TemplateImagenModel` - deny - server-side Imagen templates; deprecated and template-dependent.
- `class TemplateImagenModel` - deny - `generateImages(templateId, templateVariables, ...)`; deprecated and template-dependent.
- `interface ImagenModelParams { model; generationConfig?; safetySettings? }` - deny - Imagen model params.
- `interface ImagenGenerationConfig { negativePrompt?; numberOfImages?; aspectRatio?; imageFormat?; addWatermark? }` - deny - Imagen generation options.
- `interface ImagenGenerationResponse<T> { images; filteredReason? }` - deny - Imagen response envelope.
- `class ImagenImageFormat { mimeType; compressionQuality?; static jpeg(); static png() }` - deny - output format helper.
- `interface ImagenInlineImage { mimeType; bytesBase64Encoded }` - deny - inline generated image.
- `interface ImagenGCSImage { mimeType; gcsURI }` - deny - Cloud Storage generated image; JSDoc says the feature is not available yet.
- `const/type ImagenAspectRatio` (5 ratios) - deny - Imagen aspect ratios.
- `const/type ImagenPersonFilterLevel` (`dont_allow`, `allow_adult`, `allow_all`) - deny - person/face generation filter.
- `const/type ImagenSafetyFilterLevel` (`block_low_and_above`, `block_medium_and_above`, `block_only_high`, `block_none`) - deny - content filter aggressiveness.
- `interface ImagenSafetySettings { safetyFilterLevel?; personFilterLevel? }` - deny - Imagen safety settings.

## Denied: Live API (separate bidirectional websocket protocol; public preview)

- `getLiveGenerativeModel(ai, modelParams): LiveGenerativeModel` - deny - real-time bidirectional model; browser windows and Node >= 22 only; `@beta`.
- `class LiveGenerativeModel extends AIModel` - deny - `connect(sessionResumption?)` opens a websocket LiveSession.
- `class LiveSession` - deny - active bidirectional conversation: `send`, `sendTextRealtime`, `sendAudioRealtime`, `sendVideoRealtime`, `sendFunctionResponses`, `receive()`, `close()`, `resumeSession()`, deprecated `sendMediaChunks`/`sendMediaStream`.
- `interface LiveModelParams { model; generationConfig?; tools?; toolConfig?; systemInstruction? }` - deny.
- `interface LiveGenerationConfig` - deny - speech, sampling, transcription, and compression config for live generation.
- `const/type LiveResponseType` - deny - type-narrowing tags on live server messages.
- `interface LiveServerContent` - deny - incremental model output over the socket.
- `interface LiveServerToolCall` - deny - live function-call request.
- `interface LiveServerToolCallCancellation` - deny - cancels earlier live function calls.
- `interface LiveServerGoingAwayNotice { timeLeft }` - deny - disconnect warning.
- `interface LiveSessionResumptionUpdate { newHandle?; resumable?; lastConsumedClientMessageIndex? }` - deny - resumption state updates.
- `interface SessionResumptionConfig { handle? }` - deny - live session resumption input.
- `interface ContextWindowCompressionConfig { triggerTokens?; slidingWindow? }` - deny - live context compression.
- `interface SlidingWindow { targetTokens? }` - deny - live compression mechanism.
- `startAudioConversation(liveSession, options?): Promise<AudioConversationController>` - deny - browser microphone conversation helper; requires a user gesture.
- `interface AudioConversationController { stop }` - deny.
- `interface StartAudioConversationOptions { functionCallingHandler? }` - deny.
- `interface AudioTranscriptionConfig {}` - deny - live transcription toggle.
- `interface Transcription { text? }` - deny - live audio transcription output.
- `interface SpeechConfig { voiceConfig? }` - deny - live speech synthesis config.
- `interface VoiceConfig { prebuiltVoiceConfig? }` - deny.
- `interface PrebuiltVoiceConfig { voiceName? }` - deny.

## Denied: server-side templates (public preview; depends on server-stored templates)

- `getTemplateGenerativeModel(ai, requestOptions?): TemplateGenerativeModel` - deny - executes server-side templates; `@beta`.
- `class TemplateGenerativeModel` - deny - `generateContent(templateId, templateVariables, ...)`, `generateContentStream(...)`, `startChat(params)`; all keyed to server-stored template IDs the sandbox does not host.
- `interface TemplateChatSession` - deny - chat over a template: `sendMessage`, `sendMessageStream`, `getHistory`.
- `interface StartTemplateChatParams extends Omit<StartChatParams, 'tools'> { templateId; templateVariables?; tools? }` - deny.
- `interface TemplateFunctionDeclaration { name; description?: never; parameters?; functionReference? }` - deny - template variant; descriptions intentionally unsupported.
- `interface TemplateFunctionDeclarationsTool { functionDeclarations? }` - deny.
- `type TemplateTool = TemplateFunctionDeclarationsTool` - deny.
- `interface TemplateToolConfig { retrievalConfig? }` - deny - marked `@public` upstream but only usable through TemplateGenerativeModel requests.

## Denied: hybrid and on-device inference (depends on Chrome window.LanguageModel; browser-only)

- `interface HybridParams { mode: InferenceMode; onDeviceParams?; inCloudParams? }` - deny - configures hybrid inference; the `getGenerativeModel` overload that accepts it is not mirrored.
- `interface OnDeviceParams { createOptions?; promptOptions? }` - deny.
- `const/type InferenceMode` (`prefer_on_device`, `only_on_device`, `only_in_cloud`, `prefer_in_cloud`) - deny.
- `const/type InferenceSource` (`on_device`, `in_cloud`) - deny - only meaningful with hybrid inference; per #93 the SDK sets `inferenceSource` client-side, it never appears on the wire, so the mirrored REST plane never emits it. The optional `inferenceSource?` property on EnhancedGenerateContentResponse stays unpopulated.
- `interface ChromeAdapter { isAvailable; generateContent; generateContentStream }` - deny - wraps Chrome's on-device model; methods "should not be called directly by the user".
- `interface LanguageModelCreateCoreOptions` - deny - Chrome on-device session options.
- `interface LanguageModelCreateOptions extends LanguageModelCreateCoreOptions` - deny.
- `interface LanguageModelMessage { role; content }` - deny.
- `interface LanguageModelMessageContent { type; value }` - deny.
- `type LanguageModelMessageContentValue = ImageBitmapSource | AudioBuffer | BufferSource | string` - deny - references browser-only globals.
- `type LanguageModelMessageRole = 'system' | 'user' | 'assistant'` - deny.
- `type LanguageModelMessageType = 'text' | 'image' | 'audio'` - deny.
- `interface LanguageModelPromptOptions { responseConstraint? }` - deny.

## Denied: orphaned legacy types

- `interface RetrievedContextAttribution { uri; title }` - deny - referenced by nothing else in the installed 2.12.0 typings; leftover from the removed groundingAttributions API.
- `interface WebAttribution { uri; title }` - deny - same: an orphan with no referencing type in the installed surface.

---

## Borderline calls made

1. `FileDataPart` / `FileData`: v1. The type is a `Part` union member and rides `generateContent`. Behavior caveat recorded: the sandbox cannot fetch remote Cloud Storage URIs, so a mirror accepts the shape without resolving the bytes.
2. Grounding, URL context, and code execution types (GoogleSearchTool, GoogleMapsTool, URLContextTool, CodeExecutionTool, and their response metadata): v1. They ride the `Tool` union and `GenerateContentCandidate`, both of which are in the mirrored plane. Live retrieval and execution are backend behaviors the sandbox does not perform; that is an oracle question, not a surface exclusion.
3. `InferenceSource`: deny, despite appearing as an optional property on the v1 `EnhancedGenerateContentResponse`. It is only meaningful under hybrid inference (denied), and #93 established it is a client-side SDK addition that never rides the wire. The v1 entry notes the property stays unpopulated.
4. `ResponseModality`, `ImageConfig`, `ImageConfigAspectRatio`, `ImageConfigImageSize`: v1. They ride `GenerationConfig` on `generateContent` even though `ResponseModality` is tagged `@beta` upstream. These are Gemini image output settings, distinct from the denied Imagen family.
5. `TemplateToolConfig`: deny even though tagged `@public` upstream, because it is only reachable through TemplateGenerativeModel requests, and templates are denied as a group.
6. `RetrievedContextAttribution` and `WebAttribution`: deny as orphans. Nothing in the installed typings references them; admitting them would create rows no admitted method can ever produce.
7. `ChatSessionBase`: v1, with the note that its generic parameter bounds name two denied template types. The bounds are type-level text; the template instantiation (`TemplateChatSession`) is denied separately.
8. `Date` (the aliased `Date_2`): v1. It rides `Citation.publicationDate`. It shadows the global `Date` in import position, which is worth a mirror-side note but not a denial.

## Totals

171 exports in the installed 2.12.0 universe (170 declared names plus the `Date` alias). 112 marked v1. 59 denied.

Of the 55 runtime value exports: 38 are v1, 17 are denied (`getImagenModel`, `getTemplateImagenModel`, `ImagenAspectRatio`, `ImagenImageFormat`, `ImagenModel`, `ImagenPersonFilterLevel`, `ImagenSafetyFilterLevel`, `TemplateImagenModel`, `getLiveGenerativeModel`, `LiveGenerativeModel`, `LiveResponseType`, `LiveSession`, `startAudioConversation`, `getTemplateGenerativeModel`, `TemplateGenerativeModel`, `InferenceMode`, `InferenceSource`). The tier-1 census in `packages/conformance/src/surface-denylist.ts` only sees runtime exports, so those 17 are the entries the census gate needs; the remaining 42 denied names are type-only and matter to the typings mirror, not the runtime census.

## Draft denylist (ready to translate into packages/conformance/src/surface-denylist.ts groups)

| Export | Reason |
| --- | --- |
| getImagenModel | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026 (upstream 2.11.0 deprecation). |
| ImagenModel | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026. |
| ImagenImageFormat | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026. |
| ImagenAspectRatio | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026. |
| ImagenPersonFilterLevel | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026. |
| ImagenSafetyFilterLevel | Imagen is deprecated upstream; all Imagen models shut down as early as June 2026. |
| getTemplateImagenModel | Imagen (deprecated, June 2026 shutdown) plus server-side templates (public preview, server-stored templates the sandbox does not host). |
| TemplateImagenModel | Imagen (deprecated, June 2026 shutdown) plus server-side templates (public preview, server-stored templates the sandbox does not host). |
| getLiveGenerativeModel | Live API is a separate bidirectional websocket protocol in public preview; not part of the mirrored REST plane. |
| LiveGenerativeModel | Live API is a separate bidirectional websocket protocol in public preview; not part of the mirrored REST plane. |
| LiveSession | Live API is a separate bidirectional websocket protocol in public preview; not part of the mirrored REST plane. |
| LiveResponseType | Live API is a separate bidirectional websocket protocol in public preview; not part of the mirrored REST plane. |
| startAudioConversation | Live API browser audio helper (microphone, autoplay policies); websocket protocol in public preview. |
| getTemplateGenerativeModel | Server-side templates are public preview and depend on server-stored templates the sandbox does not host. |
| TemplateGenerativeModel | Server-side templates are public preview and depend on server-stored templates the sandbox does not host. |
| InferenceMode | Hybrid/on-device inference depends on Chrome window.LanguageModel; browser-only, not mirrorable server-side. |
| InferenceSource | Hybrid/on-device inference marker; set client-side by the SDK, never on the wire (ticket #93); meaningless without the denied hybrid mode. |

Type-only denials (for the typings mirror, same reasons by group): Imagen: `ImagenModelParams`, `ImagenGenerationConfig`, `ImagenGenerationResponse`, `ImagenInlineImage`, `ImagenGCSImage`, `ImagenSafetySettings`. Live: `LiveModelParams`, `LiveGenerationConfig`, `LiveServerContent`, `LiveServerToolCall`, `LiveServerToolCallCancellation`, `LiveServerGoingAwayNotice`, `LiveSessionResumptionUpdate`, `SessionResumptionConfig`, `ContextWindowCompressionConfig`, `SlidingWindow`, `AudioConversationController`, `StartAudioConversationOptions`, `AudioTranscriptionConfig`, `Transcription`, `SpeechConfig`, `VoiceConfig`, `PrebuiltVoiceConfig`. Templates: `TemplateChatSession`, `StartTemplateChatParams`, `TemplateFunctionDeclaration`, `TemplateFunctionDeclarationsTool`, `TemplateTool`, `TemplateToolConfig`. Hybrid/on-device: `HybridParams`, `OnDeviceParams`, `ChromeAdapter`, `LanguageModelCreateCoreOptions`, `LanguageModelCreateOptions`, `LanguageModelMessage`, `LanguageModelMessageContent`, `LanguageModelMessageContentValue`, `LanguageModelMessageRole`, `LanguageModelMessageType`, `LanguageModelPromptOptions`. Orphans: `RetrievedContextAttribution`, `WebAttribution`.

## Gist for Decisions-so-far

firebase/ai surface censused from installed firebase@12.13.0 (@firebase/ai 2.12.0): 171 public exports (55 runtime values verified against the shipped bundle, rest type-only); 112 admitted to v1 (the getAI/getGenerativeModel REST plane: GenerativeModel with generateContent/generateContentStream/startChat/countTokens, ChatSession, backends, errors, Schema builders, function calling, safety, grounding/URL-context/code-execution types, thinking and Gemini image config); 59 denied in five groups (Imagen deprecated with June 2026 shutdown, Live API websocket public preview, server-side templates public preview, hybrid/on-device Chrome-only, two orphaned attribution types); the vendored 2.13.1 clone adds 10 internal/on-device export names plus initializeDeviceModel and two behavior fixes but nothing that moves the v1 line; evidence so far is the single #93 probe, which also proved usageMetadata.serviceTier rides the wire untyped and inferenceSource/candidate-index are client-side SDK additions.
