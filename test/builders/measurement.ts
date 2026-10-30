/**
 * `measurements.jsonl`: one line per builder run, appended by `round` when
 * the run ends, and one line per verification, appended by the verifier
 * when it has judged that run. `measure` joins them by round and run id. The file is
 * append-only; nothing rewrites a line.
 *
 * A builder line holds only what the harness owns: the run's identity, what
 * the model forwarder metered, and the harness's own timing of the run
 * phase. Nothing in it is read from the run root, which the builder can
 * write, so `round` appends it before it reads anything there. What claude
 * printed, the report and the network record are in the run's
 * `report.json`.
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
  /** What the model forwarder metered from the responses it passed back, an estimate that errs high. */
  meteredCostUsd: cost,
  /** The tokens the forwarder metered; null when it metered no response. */
  tokens: tokens.nullable(),
  /** How long the run phase took, by the harness's own clock. */
  wallMs: count,
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
