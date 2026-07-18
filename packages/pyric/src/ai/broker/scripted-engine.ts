/**
 * The default AnswerEngine: scripted, zero-I/O, deterministic (cdd-deltas
 * #97 / #98.1 — "the scripted engine does no I/O anywhere").
 *
 * Zero config works: with no script, every call returns a synthesized
 * response derived from the request — wire-true in shape, obviously
 * synthetic in content — so tests and demos never hang on missing setup.
 *
 * Scripts are programmatic first: an ordered queue of entries, each either
 * a raw Gemini envelope (an observation's `behavior.raw` pastes in
 * directly) or a shorthand the synthesizer expands. Matcher semantics:
 *   - entries are consumed at most once, scanned in queue order;
 *   - a matcher (substring / regex / predicate) is checked against the last
 *     user turn's text (predicates get the whole request);
 *   - the FIRST unconsumed matching entry wins;
 *   - an entry without `match` is unconditional — next-in-queue.
 */

import {
  AiBrokerError,
  Synthesizer,
  type SynthesizeOptions,
} from './synthesizer.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  RawEnvelope,
  ScriptEntry,
  ScriptRespond,
  ScriptShorthand,
  WireChunk,
  WireResponse,
} from './types.js';

/** All text carried by the request — the prompt side of the usage estimate. */
export function promptTextOf(req: GenerateContentRequest | CountTokensRequest): string {
  const system = (req.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('');
  const contents = (req.contents ?? [])
    .flatMap((c) => c.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
  return system + contents;
}

/** Text of the last `user` turn — what string/regex matchers run against. */
export function lastUserText(req: GenerateContentRequest): string {
  const contents = req.contents ?? [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]!;
    if ((c.role ?? '').toLowerCase() === 'user') {
      return (c.parts ?? []).map((p) => p.text ?? '').join('');
    }
  }
  return '';
}

function isRawEnvelope(respond: ScriptRespond): respond is RawEnvelope {
  if ('candidates' in respond && Array.isArray((respond as { candidates?: unknown }).candidates)) {
    return true;
  }
  // A blocked-prompt capture is a complete wire envelope with
  // `promptFeedback` and no candidates — replay it verbatim too.
  return (
    'promptFeedback' in respond &&
    typeof (respond as { promptFeedback?: unknown }).promptFeedback === 'object' &&
    (respond as { promptFeedback?: unknown }).promptFeedback !== null
  );
}

export class ScriptedEngine implements AnswerEngine {
  private readonly queue: Array<{ entry: ScriptEntry; consumed: boolean }>;
  private readonly synth: Synthesizer;
  /** True only if this engine has NEVER had a script entry (constructor or push). */
  private everScripted: boolean;
  private warnedSyntheticDefault = false;

  constructor(script: ScriptEntry[] = [], synthesizer: Synthesizer = new Synthesizer()) {
    this.queue = script.map((entry) => ({ entry, consumed: false }));
    this.synth = synthesizer;
    this.everScripted = script.length > 0;
  }

  /** Append entries after construction (test-driver convenience). */
  push(...entries: ScriptEntry[]): void {
    if (entries.length > 0) this.everScripted = true;
    for (const entry of entries) this.queue.push({ entry, consumed: false });
  }

  /**
   * Fires once, ever, per engine — and only for the true zero-config case: no
   * script entry was ever queued (constructor or {@link push}). A script that
   * simply ran out mid-list is a deliberate authoring choice, not a silent
   * gap, so it never warns.
   */
  private warnSyntheticDefaultOnce(): void {
    if (this.everScripted || this.warnedSyntheticDefault) return;
    this.warnedSyntheticDefault = true;
    console.warn(
      '[pyric/ai] no script was ever queued, so this request got a synthetic placeholder answer.\n' +
        'Queue a response with pyric/ai/scripting, or pass a real engine to getAI().',
    );
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const opts = this.opts(req, model);
    const respond = this.take(req);
    if (respond === undefined) {
      this.warnSyntheticDefaultOnce();
      return specialDefault(this.synth, req, opts) ?? this.synth.text(defaultText(req), opts);
    }
    if (isRawEnvelope(respond)) return structuredClone(respond);
    return this.expandUnary(respond, opts);
  }

  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk> {
    const opts = this.opts(req, model);
    const respond = this.take(req);
    const synth = this.synth;
    if (respond === undefined) this.warnSyntheticDefaultOnce();

    return (async function* stream(): AsyncGenerator<WireChunk> {
      if (respond === undefined) {
        const special = specialDefault(synth, req, opts);
        if (special) {
          // A shaped default (JSON / forced functionCall) is one complete
          // envelope — a single-chunk stream, like a raw capture.
          yield special;
          return;
        }
        yield* synth.chunks([defaultText(req)], opts);
        return;
      }
      if (isRawEnvelope(respond)) {
        // A raw capture is one complete envelope — a single-chunk stream.
        yield structuredClone(respond);
        return;
      }
      if ('chunks' in respond) {
        yield* synth.chunks(respond.chunks, opts);
        return;
      }
      if ('error' in respond) {
        throw new AiBrokerError({ error: { ...respond.error } });
      }
      // Unary shorthand in a stream: one final chunk carrying everything.
      const single = expandNonError(synth, respond, opts);
      yield single;
    })();
  }

  async countTokens(req: CountTokensRequest, _model: string): Promise<CountTokensResponse> {
    return this.synth.countTokens(promptTextOf(req));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private opts(req: GenerateContentRequest, model: string): SynthesizeOptions {
    return { model, promptText: promptTextOf(req) };
  }

  /** First unconsumed matching entry wins; marks it consumed. */
  private take(req: GenerateContentRequest): ScriptRespond | undefined {
    const text = lastUserText(req);
    for (const slot of this.queue) {
      if (slot.consumed) continue;
      const m = slot.entry.match;
      const hit =
        m === undefined
          ? true
          : typeof m === 'string'
            ? text.includes(m)
            : m instanceof RegExp
              ? m.test(text)
              : m(req);
      if (hit) {
        slot.consumed = true;
        return slot.entry.respond;
      }
    }
    return undefined;
  }

  private expandUnary(respond: ScriptShorthand, opts: SynthesizeOptions): WireResponse {
    if ('error' in respond) throw new AiBrokerError({ error: { ...respond.error } });
    return expandNonError(this.synth, respond, opts);
  }
}

function expandNonError(
  synth: Synthesizer,
  respond: Exclude<ScriptShorthand, { error: { code: number; message: string; status: string } }>,
  opts: SynthesizeOptions,
): WireResponse {
  if ('text' in respond) return synth.text(respond.text, opts);
  if ('json' in respond) return synth.json(respond.json, opts);
  if ('functionCall' in respond) {
    return synth.functionCall(respond.functionCall.name, respond.functionCall.args, opts);
  }
  // `chunks` used with unary generateContent: join into one text envelope
  // (friendly determinism beats throwing on an authoring slip).
  return synth.text(respond.chunks.join(''), opts);
}

/** Zero-config default: deterministic and obviously synthetic. */
function defaultText(req: GenerateContentRequest): string {
  return `pyric scripted response for: ${lastUserText(req).slice(0, 40)}`;
}

/**
 * Zero-config defaults that must honor the REQUEST'S declared shape
 * (production always does; a plain synthesized sentence would violate the
 * caller's own contract):
 *
 *   - `toolConfig.functionCallingConfig.mode: 'ANY'` forces a functionCall —
 *     the synthesizer answers with the first allowed/declared function and
 *     deterministic args derived from its parameter schema.
 *   - `generationConfig.responseMimeType: 'application/json'` yields a text
 *     part that parses as JSON conforming to `responseSchema`
 *     (`ai-structured-output-shape`).
 *
 * Returns undefined when the plain deterministic text default applies.
 */
function specialDefault(
  synth: Synthesizer,
  req: GenerateContentRequest,
  opts: SynthesizeOptions,
): WireResponse | undefined {
  const callingConfig = req.toolConfig?.functionCallingConfig;
  if (callingConfig?.mode === 'ANY') {
    const declarations = (req.tools ?? []).flatMap((tool) => tool.functionDeclarations ?? []);
    const name = callingConfig.allowedFunctionNames?.[0] ?? declarations[0]?.name ?? 'function';
    const declared = declarations.find((decl) => decl.name === name);
    const sample = valueForSchema(declared?.parameters);
    const args =
      sample !== null && typeof sample === 'object' && !Array.isArray(sample)
        ? (sample as Record<string, unknown>)
        : {};
    return synth.functionCall(name, args, opts);
  }
  if (req.generationConfig?.responseMimeType === 'application/json') {
    return synth.json(valueForSchema(req.generationConfig.responseSchema), opts);
  }
  return undefined;
}

/**
 * Deterministic sample value conforming to a (JSON-normalized) response
 * schema — the zero-config stand-in for real structured output. Obviously
 * synthetic values ('pyric', 1, true), stable across calls.
 */
export function valueForSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return {};
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) return valueForSchema(s.anyOf[0]);
  const declaredType = typeof s.type === 'string' ? s.type.toLowerCase() : 'object';
  switch (declaredType) {
    case 'string':
      return Array.isArray(s.enum) && s.enum.length > 0 ? s.enum[0] : 'pyric';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [valueForSchema(s.items)];
    case 'object': {
      const out: Record<string, unknown> = {};
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(properties)) out[key] = valueForSchema(properties[key]);
      return out;
    }
    default:
      return {};
  }
}
