/**
 * Wire types for the AI broker — minimal STRUCTURAL types matching the
 * Gemini v1beta wire (GoogleAI backend), as captured by the ai-* oracle
 * observations in `packages/conformance/observations/`. Deliberately NOT imported
 * from `firebase/ai`: the broker speaks the wire, and the `pyric/ai` mirror
 * layer (next stage) owns public SDK-facing types.
 *
 * Load-bearing wire facts these types encode (see the observations):
 *   - `ai-generate-minimal-envelope`: top-level keys `candidates` /
 *     `modelVersion` / `responseId` / `usageMetadata`; usage carries
 *     `serviceTier` (undeclared by SDK typings) and `promptTokensDetails`;
 *     candidate `index` IS on the wire.
 *   - `ai-function-call-shape`: functionCall keys are `args`/`id`/`name`,
 *     and `args` is a parsed OBJECT, never a JSON string.
 *   - `ai-thinking-thought-parts` / `ai-error-fncall-missing-thought-signature`:
 *     `thoughtSignature` rides on parts (even trivial text parts) and is
 *     REQUIRED on functionCall model turns threaded back in.
 */

// ── Request side ────────────────────────────────────────────────────────────

export interface WirePart {
  text?: string;
  /** `args` is an object on the wire (`argsIsObjectNotString` fact). */
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
  /** Thought-summary flag (`includeThoughts`); thought parts never replay upstream. */
  thought?: boolean;
  /** Opaque signature production mints on parts — including trivial text parts. */
  thoughtSignature?: string;
}

export interface WireContent {
  role: string;
  parts: WirePart[];
}

export interface GenerateContentRequest {
  contents: WireContent[];
  systemInstruction?: { role?: string; parts: WirePart[] };
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE';
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    frequencyPenalty?: number;
    presencePenalty?: number;
    /** Gemini 2.5+ thinking-budget config; no OpenAI-compat equivalent (dropped by the openai engine). */
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string; includeThoughts?: boolean };
  };
}

export interface CountTokensRequest {
  contents: WireContent[];
  systemInstruction?: { role?: string; parts: WirePart[] };
}

// ── Response side ───────────────────────────────────────────────────────────

export interface WireCandidate {
  content: { parts: WirePart[]; role: 'model' };
  finishReason?: string;
  /** Present on the wire (`candidateHasIndexOnWire: true`). */
  index: number;
  /** Production adds this on function-call candidates (`ai-function-call-shape` raw). */
  finishMessage?: string;
  safetyRatings?: unknown[];
}

export interface WireUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  /** Always present on the captured wire; optional here only because the pure
   *  OpenAI translation step produces usage before the synthesizer's decorate
   *  pass fills the synthesized fields in. */
  promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
  /** Undeclared by the SDK typings but always on the captured wire. */
  serviceTier?: string;
}

/** A complete GenerateContentResponse envelope as production frames it. */
export interface WireResponse {
  candidates?: WireCandidate[];
  usageMetadata?: WireUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
}

/**
 * One streamed chunk. Every SSE event's `data:` payload is a COMPLETE
 * GenerateContentResponse (`ai-generate-stream-framing`): usageMetadata on
 * every chunk, finishReason only on the last. These are chunk OBJECTS —
 * SSE encoding (`data: ` prefix, CRLF CRLF separator) is the transport's
 * job elsewhere, not the broker's.
 */
export type WireChunk = WireResponse;

/** countTokens envelope — exactly these keys (`ai-counttokens-envelope`). */
export interface CountTokensResponse {
  totalTokens: number;
  promptTokensDetails: Array<{ modality: string; tokenCount: number }>;
}

/** Gemini error envelope: `{ error: { code, message, status } }` on every ai-error-* capture. */
export interface WireErrorEnvelope {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<Record<string, unknown>>;
  };
}

// ── The answer-engine seam (cdd-deltas #97, verbatim) ───────────────────────

export interface AnswerEngine {
  generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse>;
  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk>;
  countTokens(req: CountTokensRequest, model: string): Promise<CountTokensResponse>;
  /**
   * OPTIONAL self-report: which model this engine will ACTUALLY answer with
   * for a requested Gemini model id, and why it differs. Engines that redirect
   * silently (an openai `modelMap` entry or catch-all `model`, a gemini
   * experimental alias) implement it so the broker can announce the swap on
   * the event stream. A developer must never believe they tested model X when
   * model Y answered.
   *
   * Engines that never substitute (scripted, a caller's custom engine) omit
   * the method entirely, and the broker stays silent for them.
   */
  resolveEffectiveModel?(model: string): ModelResolution;
}

/**
 * Which model an engine answers with, and why it differs from the one the
 * request named.
 *
 * `model` is BARE (no `models/` prefix) so the broker can compare it against
 * the requested id without the prefix reading as a substitution. `reason` is
 * a short phrase for the terminal line, e.g. `engine modelMap`.
 */
export interface ModelResolution {
  model: string;
  reason: string;
}

// ── Scripted authoring ──────────────────────────────────────────────────────

/**
 * Shorthand responses. One synthesizer (synthesizer.ts) expands these into
 * wire-true envelopes and owns the shape facts.
 */
export type ScriptShorthand =
  | { text: string }
  | { json: unknown }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { chunks: string[] }
  /** Keys mirror the wire error envelope: numeric `code`, string `status`,
   *  optional `details` (the captured `@type`d detail objects ride through). */
  | { error: { code: number; message: string; status: string; details?: Array<Record<string, unknown>> } };

/**
 * A raw Gemini envelope — an observation's `behavior.raw` pastes in
 * directly (captures are the corpus). Discriminated from shorthands
 * structurally by the presence of `candidates` OR `promptFeedback`:
 * a blocked-prompt capture is a valid wire envelope that carries
 * `promptFeedback` and no candidates at all.
 */
export type RawEnvelope = WireResponse &
  (
    | { candidates: WireCandidate[] }
    | { promptFeedback: NonNullable<WireResponse['promptFeedback']> }
  );

export type ScriptRespond = ScriptShorthand | RawEnvelope;

/** Matcher: substring / regex against the last user turn text, or a predicate on the request. */
export type ScriptMatcher = string | RegExp | ((req: GenerateContentRequest) => boolean);

export interface ScriptEntry {
  /** Absent ⇒ unconditional next-in-queue. */
  match?: ScriptMatcher;
  respond: ScriptRespond;
}

// ── Engine configuration ────────────────────────────────────────────────────

export type EngineConfig =
  | { kind: 'scripted'; script?: ScriptEntry[] }
  | {
      kind: 'openai';
      /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` or serve's `/__pyric/ai-proxy`. */
      baseUrl: string;
      /** Catch-all upstream model when `modelMap` has no entry. */
      model?: string;
      /** Explicit Gemini-model-id → upstream-model mapping. */
      modelMap?: Record<string, string>;
      /** Injectable fetch for tests; defaults to globalThis.fetch. */
      fetch?: typeof fetch;
    }
  | { kind: 'gemini'; baseUrl?: string; apiKey?: string; fetch?: typeof fetch };
