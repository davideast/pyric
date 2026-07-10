/**
 * Red conformance suite: `generateContentStream` framing and aggregation rows
 * (ai#stream-*). One test per registry row id. Framing facts replay the
 * frozen capture ai-generate-stream-framing. The byte-level rows assert
 * through the framing encoder the scripting module exports, since the
 * SDK-level stream yields parsed objects, not raw SSE bytes.
 * RED BY DESIGN until the ai mirror lands (CDD map #92).
 */
import { describe, expect, test } from 'bun:test';
import { aiSeam, observedBehavior, PROBE_MODEL, type AiSeam } from './support.ts';

const framing = observedBehavior('ai-generate-stream-framing');

let seam: AiSeam;

/** Loads the seam inside the test so every row id reports its own red. */
function rowTest(name: string, fn: () => Promise<void> | void): void {
  test(name, async () => {
    seam = await aiSeam();
    await fn();
  });
}

function freshModel(entries?: any[]): any {
  const sandbox = seam.sandboxMod.initializeSandbox();
  const ai = seam.ai.getAI(sandbox);
  if (entries) seam.scripting.script(ai, entries);
  return seam.ai.getGenerativeModel(ai, { model: PROBE_MODEL });
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('ai: generateContentStream framing and aggregation', () => {
  rowTest('ai#stream-async-iterable result.stream async-iterates complete response chunks', async () => {
    const model = freshModel();
    const result = await model.generateContentStream('Count to three.');
    const chunks = await collect(result.stream);
    expect(chunks.length).toBeGreaterThan(0);
    expect(framing.everyEventParsesAsJson).toBe(true);
    for (const chunk of chunks) {
      expect(typeof chunk).toBe('object');
      expect('candidates' in chunk || 'usageMetadata' in chunk).toBe(true);
    }
  });

  rowTest('ai#stream-data-prefixed every SSE event is data:-prefixed complete JSON', () => {
    expect(framing.allEventsDataPrefixed).toBe(true);
    const raw = seam.scripting.encodeSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] }, index: 0 }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'b' }] }, finishReason: 'STOP', index: 0 }] },
    ]);
    const events = raw.split('\r\n\r\n').filter((event: string) => event.length > 0);
    expect(events.length).toBe(2);
    for (const event of events) {
      expect(event.startsWith('data: ')).toBe(true);
      expect(() => JSON.parse(event.slice('data: '.length))).not.toThrow();
    }
  });

  rowTest('ai#stream-separator-crlf SSE events are separated by CRLF CRLF', () => {
    expect(framing.separatorIsCrlfCrlf).toBe(true);
    const raw = seam.scripting.encodeSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] }, index: 0 }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'b' }] }, finishReason: 'STOP', index: 0 }] },
    ]);
    expect(raw).toContain('\r\n\r\n');
    // LF LF alone never separates two events: splitting on the CRLF form
    // must already isolate every event.
    const events = raw.split('\r\n\r\n').filter((event: string) => event.length > 0);
    for (const event of events) expect(event).not.toContain('\n\n');
  });

  rowTest('ai#stream-finish-last-chunk finishReason appears only on the last chunk', async () => {
    expect(framing.finishReasonOnlyOnLastChunk).toBe(true);
    const model = freshModel([{ respond: { chunks: ['one', ' two', ' three'] } }]);
    const result = await model.generateContentStream('Count to three.');
    const chunks = await collect(result.stream);
    const finishIndexes = chunks
      .map((chunk, index) => (chunk.candidates?.[0]?.finishReason ? index : -1))
      .filter((index) => index >= 0);
    expect(finishIndexes).toEqual([chunks.length - 1]);
  });

  rowTest('ai#stream-usage-every-chunk usageMetadata rides every chunk', async () => {
    const model = freshModel([{ respond: { chunks: ['one', ' two', ' three'] } }]);
    const result = await model.generateContentStream('Count to three.');
    const chunks = await collect(result.stream);
    // The capture shows usageMetadata on every chunk index.
    expect(framing.usageMetadataChunkIndexes.length).toBe(framing.eventCount);
    for (const chunk of chunks) expect(chunk.usageMetadata).toBeDefined();
  });

  rowTest('ai#stream-chunk-envelope every chunk carries candidates or usageMetadata', async () => {
    expect(framing.everyEventHasCandidatesOrUsage).toBe(true);
    const model = freshModel([{ respond: { chunks: ['alpha', ' beta'] } }]);
    const result = await model.generateContentStream('Two words.');
    const chunks = await collect(result.stream);
    for (const chunk of chunks) {
      expect('candidates' in chunk || 'usageMetadata' in chunk).toBe(true);
    }
  });

  rowTest('ai#stream-response-aggregate result.response concatenates the streamed text parts', async () => {
    // Text equality is allowed here because the scripted engine was
    // explicitly scripted to return these chunks.
    const model = freshModel([{ respond: { chunks: ['Hello', ' world'] } }]);
    const result = await model.generateContentStream('Greet the world.');
    await collect(result.stream);
    const aggregated = await result.response;
    expect(aggregated.text()).toBe('Hello world');
  });

  rowTest('ai#stream-aggregate-final-meta the aggregated response carries the final finishReason and usageMetadata', async () => {
    const model = freshModel([{ respond: { chunks: ['Hello', ' world'] } }]);
    const result = await model.generateContentStream('Greet the world.');
    const chunks = await collect(result.stream);
    const aggregated = await result.response;
    expect(aggregated.candidates[0].finishReason).toBe('STOP');
    expect(aggregated.usageMetadata).toEqual(chunks[chunks.length - 1].usageMetadata);
  });
});
