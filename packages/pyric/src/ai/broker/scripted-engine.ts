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
  return 'candidates' in respond && Array.isArray((respond as RawEnvelope).candidates);
}

export class ScriptedEngine implements AnswerEngine {
  private readonly queue: Array<{ entry: ScriptEntry; consumed: boolean }>;
  private readonly synth: Synthesizer;

  constructor(script: ScriptEntry[] = [], synthesizer: Synthesizer = new Synthesizer()) {
    this.queue = script.map((entry) => ({ entry, consumed: false }));
    this.synth = synthesizer;
  }

  /** Append entries after construction (test-driver convenience). */
  push(...entries: ScriptEntry[]): void {
    for (const entry of entries) this.queue.push({ entry, consumed: false });
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const opts = this.opts(req, model);
    const respond = this.take(req);
    if (respond === undefined) {
      return this.synth.text(defaultText(req), opts);
    }
    if (isRawEnvelope(respond)) return structuredClone(respond);
    return this.expandUnary(respond, opts);
  }

  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk> {
    const opts = this.opts(req, model);
    const respond = this.take(req);
    const synth = this.synth;

    return (async function* stream(): AsyncGenerator<WireChunk> {
      if (respond === undefined) {
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
