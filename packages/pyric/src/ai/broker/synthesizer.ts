/**
 * THE single place that turns script shorthands into wire-true Gemini
 * envelopes. Owns every synthesized shape fact so engines never hand-roll
 * envelopes:
 *
 *   - finishReason `STOP` default; candidate `index: 0`; role `model`
 *     (`ai-generate-minimal-envelope` candidate/content key sets).
 *   - usageMetadata synthesis: token counts estimated at ~chars/4,
 *     `promptTokensDetails: [{ modality: 'TEXT', tokenCount }]`,
 *     `serviceTier: 'standard'` (captured usage key set).
 *   - modelVersion: `-latest` aliases resolve to a fixed sandbox name via a
 *     small table (capture: `gemini-flash-lite-latest` served as
 *     `gemini-3.1-flash-lite`); unknown names pass through.
 *   - responseId: deterministic counter-based `sbx-<n>` per synthesizer
 *     instance. PINNED: two identical calls on one broker produce identical
 *     envelopes EXCEPT the responseId sequence; two fresh brokers produce
 *     byte-identical envelopes.
 *   - thoughtSignature: minted (deterministic base64, derived from the part
 *     content, NOT from responseId) on functionCall parts AND on text parts —
 *     production signs even trivial text parts (`ai-thinking-thought-parts`
 *     partKeySets `[text, thoughtSignature]`).
 *
 * Error synthesis reproduces the captured production message TEXT verbatim
 * (`ai-error-*` observations). Token counts / modelVersion / responseId /
 * thoughtSignature are the standing `by-design` "synthesized decoration"
 * divergence class (cdd-deltas #99): minted without tokenizers/classifiers.
 */

import type {
  CountTokensResponse,
  WireCandidate,
  WireErrorEnvelope,
  WirePart,
  WireResponse,
  WireUsageMetadata,
} from './types.js';

// ── Model alias table ───────────────────────────────────────────────────────

/**
 * `-latest` aliases → the fixed model version the sandbox reports. The
 * capture pinned `gemini-flash-lite-latest` → `gemini-3.1-flash-lite`;
 * siblings follow the same family shape. Anything unknown passes through
 * (model-name volatility is expected drift, cdd-deltas #99.4).
 */
const MODEL_VERSION_ALIASES: Record<string, string> = {
  'gemini-flash-lite-latest': 'gemini-3.1-flash-lite',
  'gemini-flash-latest': 'gemini-3.1-flash',
  'gemini-pro-latest': 'gemini-3.1-pro',
};

/** Strip an optional `models/` prefix and resolve `-latest` aliases. */
export function resolveModelVersion(model: string): string {
  const bare = model.startsWith('models/') ? model.slice('models/'.length) : model;
  return MODEL_VERSION_ALIASES[bare] ?? bare;
}

// ── Deterministic primitives ────────────────────────────────────────────────

/** ~chars/4, floor 1 — the sandbox's stand-in for a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** FNV-1a 32-bit — tiny, deterministic, dependency-free. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Deterministic base64-alphabet string seeded by the part content. Obviously
 * synthetic on inspection (the SDK treats it as opaque); length in the same
 * ballpark as captured signatures.
 */
export function mintThoughtSignature(seed: string): string {
  let out = '';
  let h = fnv1a(`pyric-thought:${seed}`);
  for (let i = 0; i < 48; i++) {
    out += B64[h % 64];
    h = fnv1a(`${h}:${i}`);
  }
  return out;
}

/** Deterministic functionCall part id (captured shape: short opaque string, e.g. `vrsQR5pS`). */
export function mintFunctionCallId(name: string, args: Record<string, unknown>): string {
  let h = fnv1a(`pyric-fc:${name}:${JSON.stringify(args)}`);
  let out = '';
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 8; i++) {
    out += alnum[h % alnum.length];
    h = fnv1a(`${h}:${i}`);
  }
  return out;
}

// ── Error synthesis (captured production text, verbatim) ───────────────────

/** Thrown by the broker/engines; `envelope` is the exact wire error body. */
export class AiBrokerError extends Error {
  readonly envelope: WireErrorEnvelope;
  constructor(envelope: WireErrorEnvelope) {
    super(envelope.error.message);
    this.name = 'AiBrokerError';
    this.envelope = envelope;
  }
}

export function errorEnvelope(code: number, message: string, status: string): WireErrorEnvelope {
  return { error: { code, message, status } };
}

// ── URL redaction (T1.7) ─────────────────────────────────────────────────

/**
 * Query-param names that carry plaintext credentials on upstream REST
 * requests (Google AI Studio's `?key=...` auth is the known case; the rest
 * are defensive for sibling engines / future upstreams).
 *
 * Matched with a direct regex over the raw string rather than
 * `new URL(...).searchParams` — the streaming action string embeds its own
 * `?alt=sse` before the `?key=` is appended (a pre-existing, unrelated
 * quirk this fix does not touch), which the strict `URLSearchParams` parser
 * would fold into a single malformed pair and fail to redact. A regex on
 * "`[?&]<param>=`" catches the value regardless of how the surrounding
 * query string is (mal)formed.
 */
const SENSITIVE_URL_PARAM_PATTERN = /([?&](?:key|apiKey|api_key|access_token)=)[^&\s]*/gi;

/**
 * Redacts credential-bearing query-string VALUES from a URL (or any string
 * that may embed one) before it lands in an error message or log line —
 * e.g. `?key=AIza...` becomes `?key=***`. Host and path are preserved so
 * the message stays useful for diagnosing connectivity failures; only the
 * secret value is masked.
 *
 * Used at every choke point where an upstream request URL is interpolated
 * into a thrown error or logged text, so a leaked key never reaches
 * terminal output, CI logs, or Studio traffic captures. Safe to apply
 * defensively to values that are not themselves URLs (e.g. a raw fetch
 * error message) — it is a no-op when no sensitive param is present.
 */
export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_URL_PARAM_PATTERN, '$1***');
}

/** `ai-error-unknown-model` (404 NOT_FOUND), captured text verbatim — including production's `v1main`. */
export function unknownModel(name: string): WireErrorEnvelope {
  return errorEnvelope(
    404,
    `models/${name} is not found for API version v1main, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.`,
    'NOT_FOUND',
  );
}

/** `ai-error-bad-role` (400 INVALID_ARGUMENT), captured role-list text verbatim. */
export function badRole(role: string): WireErrorEnvelope {
  return errorEnvelope(
    400,
    `Role '${role}' is not supported. Please use a valid role: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER.`,
    'INVALID_ARGUMENT',
  );
}

/** `ai-error-empty-contents` (400 INVALID_ARGUMENT) — note the trailing newline is on the wire. */
export function emptyContents(): WireErrorEnvelope {
  return errorEnvelope(
    400,
    '* GenerateContentRequest.contents: contents is not specified\n',
    'INVALID_ARGUMENT',
  );
}

/**
 * `ai-error-fncall-missing-thought-signature` (400 INVALID_ARGUMENT).
 * Production names the call `default_api:<name>` and a 1-based `position`
 * of the offending content turn; the odd ``` ` , position``` spacing is
 * captured verbatim.
 */
export function missingThoughtSignature(functionName: string, position: number): WireErrorEnvelope {
  return errorEnvelope(
    400,
    `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call \`default_api:${functionName}\` , position ${position}. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.`,
    'INVALID_ARGUMENT',
  );
}

// ── Envelope synthesis ──────────────────────────────────────────────────────

export interface SynthesizeOptions {
  /** The Gemini model id the caller requested (alias-resolved for modelVersion). */
  model: string;
  /** Prompt text used for the usage estimate (concatenated request text). */
  promptText: string;
}

export class Synthesizer {
  private responseCounter = 0;

  /** Counter-based, per-instance: `sbx-1`, `sbx-2`, … */
  nextResponseId(): string {
    this.responseCounter += 1;
    return `sbx-${this.responseCounter}`;
  }

  usage(promptText: string, candidateText: string): WireUsageMetadata {
    const promptTokenCount = estimateTokens(promptText);
    const candidatesTokenCount = estimateTokens(candidateText);
    return {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: promptTokenCount }],
      serviceTier: 'standard',
    };
  }

  /** Wire-true text envelope (the minimal-envelope key sets). */
  text(text: string, opts: SynthesizeOptions): WireResponse {
    const part: WirePart = { text, thoughtSignature: mintThoughtSignature(text) };
    return this.envelope([part], text, opts);
  }

  /** Structured-output envelope: the text part parses as JSON (`ai-structured-output-shape`). */
  json(value: unknown, opts: SynthesizeOptions): WireResponse {
    return this.text(JSON.stringify(value), opts);
  }

  /** functionCall envelope: `args`/`id`/`name` keys, args an object, part signed. */
  functionCall(
    name: string,
    args: Record<string, unknown>,
    opts: SynthesizeOptions,
  ): WireResponse {
    const part: WirePart = {
      functionCall: { name, args, id: mintFunctionCallId(name, args) },
      thoughtSignature: mintThoughtSignature(`${name}:${JSON.stringify(args)}`),
    };
    const out = this.envelope([part], JSON.stringify(args), opts);
    // Captured on function-call candidates (`ai-function-call-shape` raw).
    out.candidates![0]!.finishMessage = 'Model generated function call(s).';
    return out;
  }

  /**
   * Streaming synthesis: one complete envelope per declared chunk string.
   * Framing SEMANTICS per `ai-generate-stream-framing`: usageMetadata on
   * EVERY chunk (candidate counts cumulative), finishReason ONLY on the last
   * chunk, one responseId shared across the stream, thoughtSignature on the
   * final part. SSE encoding is the transport's job elsewhere.
   */
  chunks(chunkTexts: string[], opts: SynthesizeOptions): WireResponse[] {
    const texts = chunkTexts.length > 0 ? chunkTexts : [''];
    const responseId = this.nextResponseId();
    const modelVersion = resolveModelVersion(opts.model);
    const promptTokenCount = estimateTokens(opts.promptText);
    let emitted = '';
    return texts.map((text, i) => {
      emitted += text;
      const last = i === texts.length - 1;
      const candidatesTokenCount = estimateTokens(emitted);
      const part: WirePart = { text };
      if (last) part.thoughtSignature = mintThoughtSignature(emitted);
      const candidate: WireCandidate = {
        content: { parts: [part], role: 'model' },
        ...(last ? { finishReason: 'STOP' } : {}),
        index: 0,
      };
      return {
        candidates: [candidate],
        usageMetadata: {
          promptTokenCount,
          candidatesTokenCount,
          totalTokenCount: promptTokenCount + candidatesTokenCount,
          promptTokensDetails: [{ modality: 'TEXT', tokenCount: promptTokenCount }],
          serviceTier: 'standard',
        },
        modelVersion,
        responseId,
      };
    });
  }

  /** countTokens envelope — exactly `{ totalTokens, promptTokensDetails }`. */
  countTokens(promptText: string): CountTokensResponse {
    const totalTokens = estimateTokens(promptText);
    return {
      totalTokens,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: totalTokens }],
    };
  }

  /**
   * Decorate an engine-produced (e.g. translated-from-OpenAI) envelope with
   * the synthesized fields production always sends but upstreams lack:
   * responseId, modelVersion, serviceTier + promptTokensDetails on usage,
   * candidate index, thoughtSignature on text/functionCall parts.
   */
  decorate(resp: WireResponse, opts: SynthesizeOptions): WireResponse {
    const out: WireResponse = { ...resp };
    out.modelVersion = resp.modelVersion ?? resolveModelVersion(opts.model);
    out.responseId = resp.responseId ?? this.nextResponseId();
    if (out.candidates) {
      out.candidates = out.candidates.map((c, i) => ({
        ...c,
        index: c.index ?? i,
        content: {
          ...c.content,
          parts: c.content.parts.map((p) => this.signPart(p)),
        },
      }));
    }
    const candidateText = (out.candidates ?? [])
      .flatMap((c) => c.content.parts)
      .map((p) => p.text ?? (p.functionCall ? JSON.stringify(p.functionCall.args) : ''))
      .join('');
    const usage = out.usageMetadata;
    if (usage) {
      out.usageMetadata = {
        ...usage,
        promptTokensDetails: usage.promptTokensDetails ?? [
          { modality: 'TEXT', tokenCount: usage.promptTokenCount },
        ],
        serviceTier: usage.serviceTier ?? 'standard',
      };
    } else {
      out.usageMetadata = this.usage(opts.promptText, candidateText);
    }
    return out;
  }

  /** Sign parts the way production does (see {@link signPart}). */
  signParts(parts: WirePart[]): WirePart[] {
    return parts.map((p) => this.signPart(p));
  }

  /** Sign a part the way production does; thought parts stay unsigned (they never replay). */
  private signPart(part: WirePart): WirePart {
    if (part.thoughtSignature !== undefined || part.thought === true) return part;
    if (part.functionCall) {
      const fc = part.functionCall;
      return {
        ...part,
        functionCall: { ...fc, id: fc.id ?? mintFunctionCallId(fc.name, fc.args) },
        thoughtSignature: mintThoughtSignature(`${fc.name}:${JSON.stringify(fc.args)}`),
      };
    }
    if (typeof part.text === 'string') {
      return { ...part, thoughtSignature: mintThoughtSignature(part.text) };
    }
    return part;
  }

  private envelope(parts: WirePart[], candidateText: string, opts: SynthesizeOptions): WireResponse {
    const candidate: WireCandidate = {
      content: { parts, role: 'model' },
      finishReason: 'STOP',
      index: 0,
    };
    return {
      candidates: [candidate],
      usageMetadata: this.usage(opts.promptText, candidateText),
      modelVersion: resolveModelVersion(opts.model),
      responseId: this.nextResponseId(),
    };
  }
}
