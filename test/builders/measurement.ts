/**
 * `measurements.jsonl`: one line per builder run, appended by `round` when
 * the run ends, and one line per verification, appended by the verifier
 * when it has judged that run. `measure` joins them by round and run id. The file is
 * append-only; nothing rewrites a line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseJsonText, parseWith } from './parse.ts';

const count = z.number().int().nonnegative();
const cost = z.number().nonnegative();
const tokens = z.object({ input: count, output: count, cacheCreation: count, cacheRead: count }).strict();

export const builderMeasurementSchema = z.object({
  kind: z.literal('builder'),
  run: z.string().min(1),
  round: z.string().min(1),
  brief: z.string().min(1),
  model: z.string().min(1),
  /** The run's cap, `--max-budget-usd`. */
  maxBudgetUsd: cost,
  /** What claude said the run cost. Null when it printed no usage: it crashed or was stopped at its wall-clock cap. */
  costUsd: cost.nullable(),
  /** What the model forwarder metered from the responses it passed back, an estimate that errs high. */
  meteredCostUsd: cost,
  tokens: tokens.nullable(),
  turns: count.nullable(),
  /** Null when the run phase never said how the builder ended. */
  wallMs: count.nullable(),
  report: z.enum(['valid', 'missing', 'invalid']),
  /** The builder's own problems plus the ones the harness adds: an allowed must-be-refused action, a Google-host event. */
  problemsReported: count,
  googleHostEvents: count,
}).strict();

/** How the verifier judged each reported problem of one run. */
export const verdictCountsSchema = z.object({
  confirmed: z.object({ pyricDiffers: count, misleadingDocs: count, unclearError: count }).strict(),
  /** Reproduced, but an open or recently closed issue already has it. */
  duplicate: count,
  /** Pyric may differ, with no production evidence yet: listed for the oracle queue, not filed. */
  needsCapture: count,
  unconfirmed: count,
  builderBug: count,
  /** Problems of a run the verifier marked invalid (it broke a builder rule). */
  invalid: count,
}).strict();

export const verificationMeasurementSchema = z.object({
  kind: z.literal('verification'),
  /** The round and run it judged: run ids repeat across rounds. */
  round: z.string().min(1),
  run: z.string().min(1),
  model: z.string().min(1),
  costUsd: cost,
  tokens,
  verdicts: verdictCountsSchema,
}).strict();

export const measurementSchema = z.discriminatedUnion('kind', [builderMeasurementSchema, verificationMeasurementSchema]);

export type BuilderMeasurement = z.infer<typeof builderMeasurementSchema>;
export type VerificationMeasurement = z.infer<typeof verificationMeasurementSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type VerdictCounts = z.infer<typeof verdictCountsSchema>;

export function appendMeasurement(path: string, line: Measurement): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(measurementSchema.parse(line))}\n`);
}

/** Every line of the file, validated; a bad line is an error naming its line number, never skipped silently. */
export function readMeasurements(path: string): { lines: Measurement[]; errors: string[] } {
  if (!existsSync(path)) return { lines: [], errors: [] };
  const lines: Measurement[] = [];
  const errors: string[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
    if (text.trim() === '') return;
    const json = parseJsonText(text);
    const parsed = json.ok ? parseWith(measurementSchema, json.value) : json;
    if (parsed.ok) lines.push(parsed.value);
    else errors.push(...parsed.errors.map((error) => `line ${index + 1}: ${error}`));
  });
  return { lines, errors };
}
