/**
 * Reads the usage out of a Messages API response as it streams past the
 * forwarder, without holding the stream up. claude streams its requests as
 * server-sent events: `message_start` carries the model and the input
 * tokens, and each `message_delta` the output tokens so far
 * (https://code.claude.com/docs/en/llm-gateway-protocol, "Streaming").
 * A response that is not a stream is JSON with a top-level `usage`.
 *
 * Each field is the largest value any event gave, so a figure only grows.
 */
import { StringDecoder } from 'node:string_decoder';
import type { Tokens } from './usage.ts';

export interface MeteredUsage {
  model: string | undefined;
  tokens: Tokens;
  speed: string | undefined;
}

export interface UsageTap {
  write(chunk: Buffer): void;
  /** The usage read so far, or undefined when the response has carried none. */
  current(): MeteredUsage | undefined;
}

/** The most a JSON response or one event line may hold before the tap stops reading it. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

type RawUsage = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function countIn(usage: RawUsage, field: string): number {
  const value = usage[field];
  const isCount = typeof value === 'number' && Number.isFinite(value) && value > 0;
  return isCount ? value : 0;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function usageTap(contentType: string | undefined, requestModel: string | undefined): UsageTap {
  let seen: MeteredUsage | undefined;
  let pending = '';
  let overflow = false;
  const decoder = new StringDecoder('utf8');
  const isStream = (contentType ?? '').toLowerCase().startsWith('text/event-stream');

  const merge = (usage: unknown, model: unknown) => {
    if (!isRecord(usage)) return;
    const before = seen?.tokens ?? { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    seen = {
      model: typeof model === 'string' ? model : seen?.model ?? requestModel,
      tokens: {
        input: Math.max(before.input, countIn(usage, 'input_tokens')),
        output: Math.max(before.output, countIn(usage, 'output_tokens')),
        cacheCreation: Math.max(before.cacheCreation, countIn(usage, 'cache_creation_input_tokens')),
        cacheRead: Math.max(before.cacheRead, countIn(usage, 'cache_read_input_tokens')),
      },
      speed: typeof usage.speed === 'string' ? usage.speed : seen?.speed,
    };
  };

  const readEvent = (line: string) => {
    if (!line.startsWith('data:')) return;
    const event = parsed(line.slice('data:'.length).trim());
    if (!isRecord(event)) return;
    if (event.type === 'message_start' && isRecord(event.message)) merge(event.message.usage, event.message.model);
    if (event.type === 'message_delta') merge(event.usage, undefined);
  };

  const writeStream = (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    if (pending.length > MAX_READ_BYTES) pending = '';
    for (const line of lines) readEvent(line.replace(/\r$/, ''));
  };

  const writeJson = (text: string) => {
    if (overflow) return;
    pending += text;
    overflow = pending.length > MAX_READ_BYTES;
    const body = parsed(pending);
    if (isRecord(body)) merge(body.usage, body.model);
  };

  return {
    write: (chunk) => {
      const text = decoder.write(chunk);
      if (isStream) writeStream(text);
      else writeJson(text);
    },
    current: () => seen,
  };
}
