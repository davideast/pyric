/**
 * A builder's usage, read from the result line `claude -p --output-format
 * json` prints when it ends: tokens, cost and turns. The harness measures the
 * wall time itself. A builder that printed no result line (it crashed, or was
 * stopped at its wall-clock cap) has no usage, which the record says rather
 * than counting it as free.
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();

const resultLine = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  num_turns: count,
  total_cost_usd: z.number().nonnegative(),
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    cache_creation_input_tokens: count.optional(),
    cache_read_input_tokens: count.optional(),
  }),
});

export interface Tokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface Usage {
  tokens: Tokens;
  costUsd: number;
  turns: number;
  /** claude's own ending: `success`, or the error it stopped on, such as a spent budget. */
  ending: string;
}

function parsedLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** The usage in the last result line of a builder's output, or null when there is none. */
export function usageFrom(output: string): Usage | null {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  for (const line of lines.reverse()) {
    const result = resultLine.safeParse(parsedLine(line));
    if (!result.success) continue;
    const { usage } = result.data;
    return {
      tokens: { input: usage.input_tokens, output: usage.output_tokens, cacheCreation: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0 },
      costUsd: result.data.total_cost_usd,
      turns: result.data.num_turns,
      ending: result.data.subtype,
    };
  }
  return null;
}
