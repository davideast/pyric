# Firebase AI public-surface decision record

This is authored evidence for the Firebase AI surface review. Runtime availability
policy does not live here: the schema-validated
[`surfaces/ai.json`](../../surfaces/ai.json) contract is its only source of truth.

## Provenance

The review enumerated packages installed in this repository, not an upstream
source checkout:

- `firebase@12.13.0` re-exported bundled `@firebase/ai@2.12.0`.
- `firebase/ai` was a thin `export * from '@firebase/ai'` shim. The reviewed
  declarations were the installed package's `dist/ai-public.d.ts` (4,048 lines).
- Loading the shipped `dist/index.node.cjs.js` bundle and enumerating
  `Object.keys` produced 55 runtime values, matching the declaration review.
- The installed public universe contained 171 names: 170 declared exports plus
  `Date_2` re-exported as `Date`. Declarations marked “Excluded from this release
  type” were not counted.

Ticket #93 supplied the production evidence available during the review: one
`generateContent` call completed through the Google AI backend; the wire carried
an untyped `usageMetadata.serviceTier`; `inferenceSource` and candidate `index`
were added client-side; and App Check rejected tokenless requests before an
`AIError`-shaped client error could be observed.

## Version skew at review time

The vendored Firebase clone exposed `@firebase/ai` 2.13.1 while the installed
census universe was 2.12.0. The newer clone added internal template/wire names,
on-device model support, and behavior fixes, but did not change the reviewed V1
REST-plane boundary. In particular, `usageMetadata.serviceTier` remained absent
from both versions' declarations despite appearing on the wire.

## Boundary and type-only exclusions

The admitted V1 plane was the REST-backed `getAI` / `getGenerativeModel` family:
content generation and streaming, chat, token counting, schema builders,
function calling, safety, grounding/URL-context/code-execution response types,
thinking, and Gemini image configuration.

The review excluded 59 names: 17 runtime values now classified only in
`surfaces/ai.json`, plus these 42 type-only names. The type census retains the
names; this record retains why they were not admitted:

- Imagen, deprecated upstream with model shutdown beginning June 2026:
  `ImagenModelParams`, `ImagenGenerationConfig`, `ImagenGenerationResponse`,
  `ImagenInlineImage`, `ImagenGCSImage`, `ImagenSafetySettings`.
- Live API, a separate preview bidirectional WebSocket protocol:
  `LiveModelParams`, `LiveGenerationConfig`, `LiveServerContent`,
  `LiveServerToolCall`, `LiveServerToolCallCancellation`,
  `LiveServerGoingAwayNotice`, `LiveSessionResumptionUpdate`,
  `SessionResumptionConfig`, `ContextWindowCompressionConfig`, `SlidingWindow`,
  `AudioConversationController`, `StartAudioConversationOptions`,
  `AudioTranscriptionConfig`, `Transcription`, `SpeechConfig`, `VoiceConfig`,
  `PrebuiltVoiceConfig`.
- Server-side templates, a preview feature depending on stored templates the
  sandbox does not host: `TemplateChatSession`, `StartTemplateChatParams`,
  `TemplateFunctionDeclaration`, `TemplateFunctionDeclarationsTool`,
  `TemplateTool`, `TemplateToolConfig`.
- Hybrid/on-device inference, dependent on browser-only Chrome
  `window.LanguageModel`: `HybridParams`, `OnDeviceParams`, `ChromeAdapter`,
  `LanguageModelCreateCoreOptions`, `LanguageModelCreateOptions`,
  `LanguageModelMessage`, `LanguageModelMessageContent`,
  `LanguageModelMessageContentValue`, `LanguageModelMessageRole`,
  `LanguageModelMessageType`, `LanguageModelPromptOptions`.
- Orphaned legacy types referenced by no admitted declaration:
  `RetrievedContextAttribution`, `WebAttribution`.

## Borderline decisions

- `FileDataPart` and `FileData` were admitted because they ride the `Part` union,
  with the caveat that the sandbox does not fetch remote Cloud Storage bytes.
- Grounding, URL context, and code-execution types were admitted because they
  ride admitted request/response unions; backend execution remains a behavior
  question, not a surface exclusion.
- `InferenceSource` was excluded because it is meaningful only for hybrid
  inference and ticket #93 showed it is a client-side addition, not wire data.
- `ResponseModality`, `ImageConfig`, `ImageConfigAspectRatio`, and
  `ImageConfigImageSize` were admitted through `GenerationConfig`; they are
  distinct from the deprecated Imagen family.
- `TemplateToolConfig` was excluded despite its upstream public tag because it
  is reachable only through the excluded template plane.
- `ChatSessionBase` was admitted even though generic bounds name excluded
  template types; the template instantiation remains excluded separately.
- The aliased `Date` was admitted because it rides `Citation.publicationDate`.

At review time the final census was 112 admitted names and 59 excluded names.
Future runtime decisions must update `surfaces/ai.json`; future type-boundary
decisions must update this evidence record together with the type census ratchet.
