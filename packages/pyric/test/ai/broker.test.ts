/**
 * AI broker conformance — wires the `scripts/oracle/observations/ai-*.json`
 * captures into the suite so the broker's synthesized wire is MACHINE-CHECKED
 * against captured production behavior (auth's oracle-conformance pattern).
 *
 * Evidence tiers (cdd-deltas #99): envelope KEY SETS / enum values / framing
 * are shape facts asserted against the observation JSONs; error envelopes are
 * value-deterministic and asserted against the captured message TEXT
 * verbatim. Generated text is never compared to production output anywhere.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import {
  AiBroker,
  AiBrokerError,
  OpenAiEngine,
  ScriptedEngine,
  SseParser,
  Synthesizer,
  ToolCallBuffer,
  badRole,
  emptyContents,
  geminiToOpenAIRequest,
  loadObservationEnvelope,
  mapFinishReason,
  missingThoughtSignature,
  openAIChunkToParts,
  openAIToGeminiResponse,
  unknownModel,
  type GenerateContentRequest,
  type OpenAIResponse,
  type WireChunk,
  type WireResponse,
} from '../../src/ai/broker/index.js';

// ai-* observations live under the 'ai' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'ai');

function loadObs(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8'));
}

const MODEL = 'gemini-flash-lite-latest';

function userReq(text: string): GenerateContentRequest {
  return { contents: [{ role: 'user', parts: [{ text }] }] };
}

function keySet(obj: object): string[] {
  return Object.keys(obj).sort();
}

async function collect(stream: AsyncIterable<WireChunk>): Promise<WireChunk[]> {
  const out: WireChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

async function envelopeOf(promise: Promise<unknown>): Promise<AiBrokerError['envelope']> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AiBrokerError);
    return (err as AiBrokerError).envelope;
  }
  throw new Error('expected AiBrokerError');
}

// ── Synthesizer envelope shape vs ai-generate-minimal-envelope ──────────────

describe('synthesizer envelope facts (ai-generate-minimal-envelope)', () => {
  const obs = loadObs('ai-generate-minimal-envelope.json').behavior;

  async function minimal(): Promise<WireResponse> {
    return new AiBroker().generateContent(userReq('say pyric'), MODEL);
  }

  it('reproduces the captured top-level key set', async () => {
    expect(keySet(await minimal())).toEqual([...obs.topLevelKeySet].sort());
  });

  it('reproduces the captured candidate / content key sets and enums', async () => {
    const res = await minimal();
    const candidate = res.candidates![0]!;
    expect(keySet(candidate)).toEqual([...obs.candidateKeySet].sort());
    expect(candidate.index).toBe(0); // candidateHasIndexOnWire
    expect(candidate.finishReason).toBe(obs.finishReason); // STOP
    expect(keySet(candidate.content)).toEqual([...obs.contentKeySet].sort());
    expect(candidate.content.role).toBe(obs.contentRole); // 'model'
  });

  it('reproduces the captured usageMetadata key set with serviceTier', async () => {
    const usage = (await minimal()).usageMetadata!;
    expect(keySet(usage)).toEqual([...obs.usageKeySet].sort());
    expect(usage.serviceTier).toBe('standard');
    expect(usage.totalTokenCount).toBe(usage.promptTokenCount + usage.candidatesTokenCount);
    expect(usage.promptTokensDetails).toEqual([
      { modality: 'TEXT', tokenCount: usage.promptTokenCount },
    ]);
  });

  it('resolves the -latest alias to the captured fixed model version', async () => {
    expect((await minimal()).modelVersion).toBe(obs.modelVersion); // gemini-3.1-flash-lite
  });

  it('passes unknown model names through as modelVersion', async () => {
    const res = await new AiBroker().generateContent(userReq('hi'), 'my-custom-model');
    expect(res.modelVersion).toBe('my-custom-model');
  });

  it('signs even trivial text parts (ai-thinking-thought-parts partKeySets)', async () => {
    const part = (await minimal()).candidates![0]!.content.parts[0]!;
    expect(keySet(part)).toEqual(['text', 'thoughtSignature']);
    expect(part.thoughtSignature).toMatch(/^[A-Za-z0-9+/]+$/);
  });
});

// ── Streaming chunk semantics vs ai-generate-stream-framing ─────────────────

describe('streaming chunk semantics (ai-generate-stream-framing)', () => {
  const obs = loadObs('ai-generate-stream-framing.json').behavior;

  async function stream(): Promise<WireChunk[]> {
    const broker = new AiBroker({
      engine: { kind: 'scripted', script: [{ respond: { chunks: ['1 2 3 4 5 6 7 8', ' 9 10'] } }] },
    });
    return collect(broker.streamGenerateContent(userReq('count to ten'), MODEL));
  }

  it('emits one chunk per declared element', async () => {
    expect((await stream()).length).toBe(2);
  });

  it('puts finishReason ONLY on the last chunk', async () => {
    const chunks = await stream();
    const finishIndexes = chunks
      .map((c, i) => (c.candidates![0]!.finishReason !== undefined ? i : -1))
      .filter((i) => i >= 0);
    expect(finishIndexes).toEqual([chunks.length - 1]); // finishReasonOnlyOnLastChunk
    expect(chunks.at(-1)!.candidates![0]!.finishReason).toBe('STOP');
  });

  it('puts usageMetadata on EVERY chunk', async () => {
    const chunks = await stream();
    for (const c of chunks) {
      expect(c.usageMetadata).toBeDefined();
      expect(c.usageMetadata!.serviceTier).toBe('standard');
    }
    expect(obs.usageMetadataChunkIndexes.length).toBe(obs.eventCount); // the captured fact itself
  });

  it('every chunk is a complete envelope: candidates or usage, one responseId', async () => {
    const chunks = await stream();
    for (const c of chunks) {
      expect(Boolean(c.candidates || c.usageMetadata)).toBe(true);
      expect(c.responseId).toBe(chunks[0]!.responseId);
      expect(c.modelVersion).toBe('gemini-3.1-flash-lite');
    }
  });

  it('candidate token counts are cumulative and the final part is signed', async () => {
    const chunks = await stream();
    const counts = chunks.map((c) => c.usageMetadata!.candidatesTokenCount);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    expect(chunks.at(-1)!.candidates![0]!.content.parts[0]!.thoughtSignature).toBeDefined();
    expect(chunks[0]!.candidates![0]!.content.parts[0]!.thoughtSignature).toBeUndefined();
  });

  it('zero-config streaming still yields wire-true framing', async () => {
    const chunks = await collect(new AiBroker().streamGenerateContent(userReq('hi'), MODEL));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)!.candidates![0]!.finishReason).toBe('STOP');
    for (const c of chunks) expect(c.usageMetadata).toBeDefined();
  });
});

// ── Scripted queue and matcher order ────────────────────────────────────────

describe('scripted engine queue and matchers', () => {
  it('matches substring / regex / predicate against the last user turn, in queue order', async () => {
    const broker = new AiBroker({
      engine: {
        kind: 'scripted',
        script: [
          { match: 'weather', respond: { text: 'matched-substring' } },
          { match: /PyRiC/i, respond: { text: 'matched-regex' } },
          { match: (req) => (req.tools?.length ?? 0) > 0, respond: { text: 'matched-predicate' } },
          { respond: { text: 'unconditional' } },
        ],
      },
    });
    const textOf = (r: WireResponse) => r.candidates![0]!.content.parts[0]!.text;

    const r1 = await broker.generateContent(userReq('what is the weather in paris'), MODEL);
    expect(textOf(r1)).toBe('matched-substring');

    const r2 = await broker.generateContent(userReq('tell me about pyric'), MODEL);
    expect(textOf(r2)).toBe('matched-regex');

    const r3 = await broker.generateContent(
      {
        contents: [{ role: 'user', parts: [{ text: 'call something' }] }],
        tools: [{ functionDeclarations: [{ name: 'f' }] }],
      },
      MODEL,
    );
    expect(textOf(r3)).toBe('matched-predicate');

    // Everything matched is consumed; entry without match is next-in-queue.
    const r4 = await broker.generateContent(userReq('anything at all'), MODEL);
    expect(textOf(r4)).toBe('unconditional');

    // Queue exhausted -> zero-config default.
    const r5 = await broker.generateContent(userReq('anything again'), MODEL);
    expect(textOf(r5)).toBe('pyric scripted response for: anything again');
  });

  it('consumes each entry at most once and matches on the LAST user turn', async () => {
    const engine = new ScriptedEngine([
      { match: 'again', respond: { text: 'first' } },
      { match: 'again', respond: { text: 'second' } },
    ]);
    const multiTurn: GenerateContentRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'again' }] },
        { role: 'model', parts: [{ text: 'sure' }] },
        { role: 'user', parts: [{ text: 'nope' }] }, // last user turn does NOT match
      ],
    };
    const miss = await engine.generateContent(multiTurn, MODEL);
    expect(miss.candidates![0]!.content.parts[0]!.text).toBe('pyric scripted response for: nope');

    const hit1 = await engine.generateContent(userReq('again'), MODEL);
    const hit2 = await engine.generateContent(userReq('again'), MODEL);
    expect(hit1.candidates![0]!.content.parts[0]!.text).toBe('first');
    expect(hit2.candidates![0]!.content.parts[0]!.text).toBe('second');
  });

  it('an unconditional entry earlier in the queue wins over a later matcher', async () => {
    const engine = new ScriptedEngine([
      { respond: { text: 'unconditional-first' } },
      { match: 'weather', respond: { text: 'matcher-second' } },
    ]);
    const res = await engine.generateContent(userReq('weather'), MODEL);
    expect(res.candidates![0]!.content.parts[0]!.text).toBe('unconditional-first');
  });

  it('a raw observation envelope pastes in via loadObservationEnvelope and replays verbatim', async () => {
    const obs = loadObs('ai-generate-minimal-envelope.json');
    const broker = new AiBroker({
      engine: { kind: 'scripted', script: [{ respond: loadObservationEnvelope(obs) }] },
    });
    const res = await broker.generateContent(userReq('say pyric'), MODEL);
    expect(res).toEqual(obs.behavior.raw);
  });

  it('functionCall shorthand reproduces the captured part shape (ai-function-call-shape)', async () => {
    const obs = loadObs('ai-function-call-shape.json').behavior;
    const broker = new AiBroker({
      engine: {
        kind: 'scripted',
        script: [{ respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } } }],
      },
    });
    const res = await broker.generateContent(userReq('weather in paris?'), MODEL);
    const part = res.candidates![0]!.content.parts[0]!;
    expect(keySet(part.functionCall!)).toEqual([...obs.functionCallKeySet].sort()); // args,id,name
    expect(typeof part.functionCall!.args).toBe('object'); // argsIsObjectNotString
    expect(part.functionCall!.args).toEqual({ city: 'Paris' });
    expect(part.thoughtSignature).toBeDefined();
    expect(res.candidates![0]!.finishReason).toBe(obs.finishReason);
    expect(res.candidates![0]!.finishMessage).toBe('Model generated function call(s).');
  });

  it('json shorthand emits text that parses as JSON (ai-structured-output-shape)', async () => {
    const broker = new AiBroker({
      engine: { kind: 'scripted', script: [{ respond: { json: { word: 'ember' } } }] },
    });
    const res = await broker.generateContent(userReq('one word'), MODEL);
    const text = res.candidates![0]!.content.parts[0]!.text!;
    expect(keySet(JSON.parse(text))).toEqual(['word']);
  });

  it('error shorthand throws the wire envelope from unary and stream calls', async () => {
    const entry = { respond: { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } } };
    const broker = new AiBroker({ engine: { kind: 'scripted', script: [entry, entry] } });
    const env = await envelopeOf(broker.generateContent(userReq('x'), MODEL));
    expect(env).toEqual({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } });
    const streamEnv = await envelopeOf(collect(broker.streamGenerateContent(userReq('x'), MODEL)));
    expect(streamEnv.error.code).toBe(429);
  });
});

// ── Zero-config determinism ─────────────────────────────────────────────────

describe('zero-config determinism (pinned)', () => {
  it('two fresh brokers produce byte-identical envelopes', async () => {
    const a = await new AiBroker().generateContent(userReq('determinism check'), MODEL);
    const b = await new AiBroker().generateContent(userReq('determinism check'), MODEL);
    expect(a).toEqual(b);
    expect(a.responseId).toBe('sbx-1');
  });

  it('one broker, identical calls: identical except the responseId sequence', async () => {
    const broker = new AiBroker();
    const first = await broker.generateContent(userReq('determinism check'), MODEL);
    const second = await broker.generateContent(userReq('determinism check'), MODEL);
    expect(first.responseId).toBe('sbx-1');
    expect(second.responseId).toBe('sbx-2');
    const strip = (r: WireResponse) => ({ ...r, responseId: undefined });
    expect(strip(first)).toEqual(strip(second)); // thoughtSignature et al identical
  });

  it('countTokens is deterministic across two identical calls (ai-counttokens-envelope)', async () => {
    const obs = loadObs('ai-counttokens-envelope.json').behavior;
    const broker = new AiBroker();
    const a = await broker.countTokens(userReq('why is the sky blue?'), MODEL);
    const b = await broker.countTokens(userReq('why is the sky blue?'), MODEL);
    expect(a).toEqual(b); // deterministicAcrossTwoCalls
    expect(keySet(a)).toEqual([...obs.topLevelKeySet].sort()); // exactly totalTokens+promptTokensDetails
    expect(a.promptTokensDetails[0]!.modality).toBe('TEXT');
  });
});

// ── Error synthesis vs captured production text ─────────────────────────────

describe('error synthesis matches captured envelopes verbatim', () => {
  it('unknownModel reproduces ai-error-unknown-model', () => {
    const obs = loadObs('ai-error-unknown-model.json').behavior;
    expect(unknownModel('not-a-real-model')).toEqual(obs.raw);
    expect(unknownModel('not-a-real-model').error.message).toBe(obs.messageText);
  });

  it('badRole reproduces ai-error-bad-role, and the broker rejects a bad role with it', async () => {
    const obs = loadObs('ai-error-bad-role.json').behavior;
    expect(badRole('banana')).toEqual(obs.raw);
    const broker = new AiBroker();
    const env = await envelopeOf(
      broker.generateContent({ contents: [{ role: 'banana', parts: [{ text: 'hi' }] }] }, MODEL),
    );
    expect(env).toEqual(obs.raw);
    expect(env.error.message).toBe(obs.messageText);
  });

  it('empty contents rejects with ai-error-empty-contents (trailing newline and all)', async () => {
    const obs = loadObs('ai-error-empty-contents.json').behavior;
    expect(emptyContents()).toEqual(obs.raw);
    const env = await envelopeOf(new AiBroker().generateContent({ contents: [] }, MODEL));
    expect(env).toEqual(obs.raw);
  });

  it('an unsigned functionCall model turn rejects with the captured 400 (fncall-missing-thought-signature)', async () => {
    const obs = loadObs('ai-error-fncall-missing-thought-signature.json').behavior;
    const contents: GenerateContentRequest['contents'] = [
      { role: 'user', parts: [{ text: 'weather in Paris?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
      {
        role: 'function',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 22 } } }],
      },
    ];
    const env = await envelopeOf(new AiBroker().generateContent({ contents }, MODEL));
    expect(env).toEqual(obs.raw);
    expect(env.error.message).toBe(obs.messageText); // names default_api:get_weather, position 2

    expect(missingThoughtSignature('get_weather', 2)).toEqual(obs.raw);
  });

  it('the SAME functionCall turn passes once signed (ai-function-response-round)', async () => {
    const contents: GenerateContentRequest['contents'] = [
      { role: 'user', parts: [{ text: 'weather in Paris?' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'get_weather', args: { city: 'Paris' } },
            thoughtSignature: 'EjQKMgERTTIPevU90Ul2ojBM',
          },
        ],
      },
      {
        role: 'function',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 22 } } }],
      },
    ];
    const res = await new AiBroker().generateContent({ contents }, MODEL);
    expect(res.candidates![0]!.finishReason).toBe('STOP');
  });

  it('stream validation is EAGER: a bad request throws before iteration', () => {
    expect(() => new AiBroker().streamGenerateContent({ contents: [] }, MODEL)).toThrow(
      AiBrokerError,
    );
  });
});

// ── OpenAI translation units (pure, no network) ─────────────────────────────

describe('openai translation: request mapping', () => {
  it('maps systemInstruction, text turns, tools, toolConfig and generationConfig', () => {
    const req: GenerateContentRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { parts: [{ text: 'be terse' }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'OBJECT', properties: { city: { type: 'STRING', nullable: true } } },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        topK: 40, // lossy edge: dropped
        maxOutputTokens: 128,
        stopSequences: ['END'],
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { word: { type: 'STRING' } } },
      },
    };
    const out = geminiToOpenAIRequest('llama3', req, false);
    expect(out.model).toBe('llama3');
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(out.tools![0]!.function.name).toBe('get_weather');
    expect((out.tools![0]!.function.parameters as any).type).toBe('object'); // normalized
    expect((out.tools![0]!.function.parameters as any).properties.city.nullable).toBeUndefined();
    expect(out.tool_choice).toBe('required');
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(128);
    expect(out.stop).toEqual(['END']);
    expect((out as any).topK).toBeUndefined();
    expect(out.response_format!.type).toBe('json_schema');
    expect(out.stream).toBe(false);
    expect(out.stream_options).toBeUndefined();
  });

  it('synthesizes FIFO tool ids per function name across the round trip (lossy edge #1)', () => {
    const req: GenerateContentRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'two calls' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'f', args: { n: 1 } }, thoughtSignature: 'sig1' },
            { functionCall: { name: 'f', args: { n: 2 } }, thoughtSignature: 'sig2' },
          ],
        },
        {
          role: 'function',
          parts: [
            { functionResponse: { name: 'f', response: { r: 1 } } },
            { functionResponse: { name: 'f', response: { r: 2 } } },
          ],
        },
      ],
    };
    const out = geminiToOpenAIRequest('m', req, false);
    const assistant = out.messages[1]!;
    expect(assistant.tool_calls!.map((t) => t.id)).toEqual(['call_f_0', 'call_f_1']);
    // args serialized to a JSON string (lossy edge, reverse of the wire fact)
    expect(assistant.tool_calls![0]!.function.arguments).toBe('{"n":1}');
    const toolMsgs = out.messages.slice(2);
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_f_0', 'call_f_1']); // FIFO
    expect(toolMsgs[0]!.content).toBe('{"r":1}');
  });

  it('skips thought parts when replaying history to OpenAI (lossy edge #4)', () => {
    const req: GenerateContentRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { text: 'secret reasoning', thought: true },
            { text: 'visible answer', thoughtSignature: 'sig' },
          ],
        },
        { role: 'user', parts: [{ text: 'next' }] },
      ],
    };
    const out = geminiToOpenAIRequest('m', req, true);
    expect(out.messages[1]!.content).toBe('visible answer');
    expect(JSON.stringify(out)).not.toContain('secret reasoning');
    expect(JSON.stringify(out)).not.toContain('thoughtSignature'); // no OpenAI equivalent; dropped
    expect(out.stream_options).toEqual({ include_usage: true });
  });
});

describe('openai translation: response and chunk mapping', () => {
  it('maps finish reasons, including content_filter -> SAFETY', () => {
    expect(mapFinishReason('stop')).toBe('STOP');
    expect(mapFinishReason('length')).toBe('MAX_TOKENS');
    expect(mapFinishReason('tool_calls')).toBe('STOP');
    expect(mapFinishReason('content_filter')).toBe('SAFETY');
    expect(mapFinishReason('weird')).toBe('OTHER');
    expect(mapFinishReason(null)).toBe('STOP');
  });

  it('maps a tool-call response to a whole functionCall part with OBJECT args', () => {
    const resp: OpenAIResponse = {
      id: 'x',
      model: 'llama3',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const out = openAIToGeminiResponse(resp);
    const part = out.candidates![0]!.content.parts[0]!;
    expect(part.functionCall).toEqual({ name: 'get_weather', args: { city: 'Paris' } });
    expect(out.candidates![0]!.finishReason).toBe('STOP');
    expect(out.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    });
  });

  it('malformed tool-call JSON maps to MALFORMED_FUNCTION_CALL', () => {
    const resp: OpenAIResponse = {
      id: 'x',
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{oops' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    expect(openAIToGeminiResponse(resp).candidates![0]!.finishReason).toBe(
      'MALFORMED_FUNCTION_CALL',
    );
  });

  it('maps stream deltas: content -> text part, reasoning -> thought part', () => {
    const parts = openAIChunkToParts({
      id: 'x',
      model: 'm',
      choices: [{ index: 0, delta: { reasoning: 'hmm', content: 'hi' }, finish_reason: null }],
    });
    expect(parts).toEqual([{ text: 'hmm', thought: true }, { text: 'hi' }]);
  });

  it('ToolCallBuffer accumulates streamed fragments into whole functionCall parts', () => {
    const buffer = new ToolCallBuffer();
    buffer.add([{ index: 0, function: { name: 'get_', arguments: '' } } as any]);
    buffer.add([{ index: 0, function: { name: 'weather', arguments: '{"cit' } } as any]);
    buffer.add([{ index: 0, function: { arguments: 'y":"Paris"}' } } as any]);
    const parts = buffer.flush();
    expect(parts).toEqual([{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }]);
    expect(buffer.flush()).toEqual([]); // emitted exactly once
  });

  it('SseParser handles LF LF and CRLF CRLF, split pushes, and surfaces [DONE] for the caller to skip', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]); // incomplete event buffers
    expect(parser.push(':1}\n\ndata: {"b":2}\r\n\r\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(parser.push('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });
});

// ── OpenAI engine end-to-end with mocked fetch (no network) ─────────────────

function jsonFetch(handler: (url: string, body: any) => Response): typeof fetch {
  return (async (url: any, init: any) => handler(String(url), JSON.parse(init.body))) as typeof fetch;
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('openai engine (mocked fetch)', () => {
  const upstreamUnary: OpenAIResponse = {
    id: 'chatcmpl-1',
    model: 'llama3',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'bonjour' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };

  it('maps models: modelMap wins, then config.model, then passthrough', async () => {
    const seen: string[] = [];
    const fetchImpl = jsonFetch((_url, body) => {
      seen.push(body.model);
      return Response.json(upstreamUnary);
    });

    await new OpenAiEngine({
      baseUrl: 'http://up/v1',
      model: 'fallback-model',
      modelMap: { 'gemini-flash-lite-latest': 'qwen3' },
      fetch: fetchImpl,
    }).generateContent(userReq('hi'), MODEL);
    await new OpenAiEngine({
      baseUrl: 'http://up/v1',
      model: 'fallback-model',
      fetch: fetchImpl,
    }).generateContent(userReq('hi'), MODEL);
    await new OpenAiEngine({ baseUrl: 'http://up/v1', fetch: fetchImpl }).generateContent(
      userReq('hi'),
      'models/some-model',
    );
    expect(seen).toEqual(['qwen3', 'fallback-model', 'some-model']);
  });

  it('default fetch never runs with the engine as its receiver (browser Illegal invocation guard)', async () => {
    // Regression guard for the serve e2e finding (test/e2e/ai-demo.pw.ts in
    // pyric-tools): `options.fetch ?? fetch` stored the global BARE, so
    // `this.fetchImpl(...)` invoked fetch with the engine as `this` — an
    // Illegal invocation in browsers and workers (Node tolerates it, which is
    // why only a real SharedWorker surfaced it). The default must be a
    // wrapper that calls the global with a neutral receiver.
    const receivers: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async function (this: unknown, ..._args: unknown[]) {
      receivers.push(this);
      return Response.json(upstreamUnary);
    } as typeof fetch;
    try {
      const engine = new OpenAiEngine({ baseUrl: 'http://up/v1' });
      await engine.generateContent(userReq('hi'), MODEL);
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).not.toBe(engine);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('decorates the translated envelope wire-true: responseId, modelVersion, serviceTier, signed parts', async () => {
    const engine = new OpenAiEngine({
      baseUrl: 'http://up/v1',
      fetch: jsonFetch(() => Response.json(upstreamUnary)),
    });
    const res = await engine.generateContent(userReq('translate hello'), MODEL);
    expect(keySet(res)).toEqual(['candidates', 'modelVersion', 'responseId', 'usageMetadata']);
    expect(res.modelVersion).toBe('gemini-3.1-flash-lite'); // Gemini alias, not the upstream name
    expect(res.responseId).toBe('sbx-1');
    expect(res.usageMetadata).toEqual({
      promptTokenCount: 7,
      candidatesTokenCount: 3,
      totalTokenCount: 10,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 7 }],
      serviceTier: 'standard',
    });
    const part = res.candidates![0]!.content.parts[0]!;
    expect(part.text).toBe('bonjour');
    expect(part.thoughtSignature).toBeDefined(); // minted on the Gemini side (lossy edge #5)
  });

  it('streams: buffers tool-call fragments whole, frames usage on every chunk, never forwards [DONE]', async () => {
    const frames = [
      `data: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n`,
      `data: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{"content":"Sure, "},"finish_reason":null}]}\r\n\r\n`,
      `data: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{"content":"calling now"},"finish_reason":null}]}\r\n`,
      `\r\ndata: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]},"finish_reason":null}]}\r\n\r\n`,
      `data: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Paris\\"}"}}]},"finish_reason":null}]}\r\n\r\n`,
      `data: {"id":"c","model":"llama3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\n`,
      `data: {"id":"c","model":"llama3","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9,"total_tokens":29}}\r\n\r\n`,
      `data: [DONE]\r\n\r\n`,
    ];
    const engine = new OpenAiEngine({
      baseUrl: 'http://up/v1',
      fetch: (async () => sseResponse(frames)) as typeof fetch,
    });
    const chunks = await collect(engine.streamGenerateContent(userReq('weather?'), MODEL));

    // Text deltas stream through; the finish chunk is last.
    const texts = chunks.flatMap((c) => c.candidates![0]!.content.parts.map((p) => p.text ?? ''));
    expect(texts.join('')).toContain('Sure, calling now');

    // finishReason ONLY on the last chunk; STOP (tool_calls maps to STOP).
    chunks.slice(0, -1).forEach((c) => expect(c.candidates![0]!.finishReason).toBeUndefined());
    const last = chunks.at(-1)!;
    expect(last.candidates![0]!.finishReason).toBe('STOP');

    // The fragmented tool call emerges WHOLE, exactly once, on the finish chunk.
    const fnParts = chunks.flatMap((c) =>
      c.candidates![0]!.content.parts.filter((p) => p.functionCall),
    );
    expect(fnParts.length).toBe(1);
    expect(fnParts[0]!.functionCall!.name).toBe('get_weather');
    expect(fnParts[0]!.functionCall!.args).toEqual({ city: 'Paris' });
    expect(fnParts[0]!.functionCall!.id).toBeDefined();
    expect(fnParts[0]!.thoughtSignature).toBeDefined();

    // usageMetadata on EVERY chunk; the final chunk carries upstream numbers.
    for (const c of chunks) {
      expect(c.usageMetadata).toBeDefined();
      expect(c.usageMetadata!.serviceTier).toBe('standard');
      expect(c.responseId).toBe(chunks[0]!.responseId);
    }
    expect(last.usageMetadata!.totalTokenCount).toBe(29);

    // Nothing derived from the [DONE] sentinel (it would have JSON.parse-crashed anyway).
    expect(chunks.length).toBe(3); // two text chunks + one finish chunk
  });

  it('maps upstream content_filter to SAFETY', async () => {
    const filtered: OpenAIResponse = {
      id: 'x',
      model: 'm',
      choices: [
        { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' },
      ],
    };
    const engine = new OpenAiEngine({
      baseUrl: 'http://up/v1',
      fetch: jsonFetch(() => Response.json(filtered)),
    });
    const res = await engine.generateContent(userReq('nope'), MODEL);
    expect(res.candidates![0]!.finishReason).toBe('SAFETY');
  });

  it('wraps upstream failures in a Gemini-shaped error envelope', async () => {
    const engine = new OpenAiEngine({
      baseUrl: 'http://up/v1',
      fetch: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    const env = await envelopeOf(engine.generateContent(userReq('x'), 'm'));
    expect(keySet(env.error)).toEqual(['code', 'message', 'status']);
    expect(env.error.code).toBe(500);
  });
});

// ── Broker: engine seam + sandbox event emission ────────────────────────────

describe('broker sandbox event emission', () => {
  it('lands service_mutation events for ops on the unified stream', async () => {
    const sandbox = initializeSandbox();
    const events: any[] = [];
    sandbox.onEvent((e: any) => {
      if (e.kind === 'service_mutation' && e.service === 'ai') events.push(e);
    });
    const broker = new AiBroker({ sandbox });

    await broker.generateContent(userReq('hello'), MODEL);
    await collect(broker.streamGenerateContent(userReq('hello'), MODEL));
    await broker.countTokens(userReq('hello'), MODEL);
    await envelopeOf(broker.generateContent({ contents: [] }, MODEL));

    expect(events.map((e) => e.op)).toEqual([
      'generate_content',
      'stream_generate_content',
      'count_tokens',
      'request_rejected',
    ]);
    expect(events[0].path).toBe(MODEL);
    expect(events[0].auth).toBeNull();
    expect(events[0].detail.finishReason).toBe('STOP');
    expect(events[1].detail.chunkCount).toBe(1);
    expect(events[3].detail.status).toBe('INVALID_ARGUMENT');
  });

  it('a throwing event consumer never poisons the broker (handler errors are the consumer problem)', async () => {
    const sandbox = initializeSandbox();
    sandbox.onEvent(() => {
      throw new Error('consumer bug');
    });
    const broker = new AiBroker({ sandbox });
    const res = await broker.generateContent(userReq('still fine'), MODEL);
    expect(res.candidates![0]!.finishReason).toBe('STOP');
  });

  it('works with no sandbox at all (events are optional)', async () => {
    const res = await new AiBroker().generateContent(userReq('no sandbox'), MODEL);
    expect(res.candidates).toBeDefined();
  });

  it('accepts a custom AnswerEngine through the seam', async () => {
    const custom = {
      generateContent: async () => ({ candidates: [] }) as WireResponse,
      streamGenerateContent: () => (async function* g(): AsyncGenerator<WireChunk> {})(),
      countTokens: async () => ({ totalTokens: 42, promptTokensDetails: [] }),
    };
    const broker = new AiBroker({ engine: custom });
    expect((await broker.countTokens(userReq('x'), MODEL)).totalTokens).toBe(42);
  });

  it('loadObservationEnvelope rejects observations without a raw response envelope', () => {
    expect(() => loadObservationEnvelope(loadObs('ai-error-bad-role.json'))).toThrow(
      /behavior\.raw/,
    );
  });
});
