/**
 * The builder's report: `report.json`, which the builder writes in its run
 * directory. `round` validates it, and the run's record (`run-record.ts`)
 * holds it beside the fields a builder can't edit. A report with a field the
 * shape doesn't name fails validation, so a builder can't pass off its own
 * `network` or `usage`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseJsonText, parseWith, type Parsed } from './parse.ts';

const text = z.string().trim().min(1);
const stepNumber = z.number().int().positive();

const step = z.object({
  n: stepNumber,
  did: text,
  result: z.enum(['worked', 'broke', 'stuck']),
  /** A path inside the run directory. */
  log: z.string(),
}).strict();

/** The forms of the selectors the harness gives its own problems (`repro-target.ts`), which a builder's id must not take. */
export const RESERVED_PROBLEM_ID = /^(refusal-allowed-\d+$|google-host:)/;

const problem = z.object({
  id: text.refine((id) => !RESERVED_PROBLEM_ID.test(id), 'must not take the form of a harness selector (refusal-allowed-<n>, google-host:<host>)'),
  summary: text,
  step: stepNumber,
  /** What the docs said would happen; null when no page led the builder to expect anything. */
  docsLedMeToExpect: z.object({ page: text, quote: text }).strict().nullable(),
  whatHappened: text,
  errorText: z.string(),
  logs: z.array(z.string()),
  reproHint: text,
}).strict();

export const REFUSAL_RESULTS = ['refused', 'allowed', 'not-attempted'] as const;

const refusal = z.object({
  action: text,
  firebaseDoc: text,
  productionAnswer: text,
  pyricAnswer: z.string(),
  result: z.enum(REFUSAL_RESULTS),
}).strict();

const stuck = z.object({ where: text, lastError: z.string(), whatIWouldTryNext: text }).strict();

const isDistinct = (values: readonly string[]) => new Set(values).size === values.length;

export const builderReportSchema = z.object({
  steps: z.array(step),
  worked: z.array(text),
  problems: z.array(problem).refine((problems) => isDistinct(problems.map((entry) => entry.id)), 'problem ids must be distinct'),
  refusals: z.array(refusal),
  stuck: stuck.nullable(),
}).strict();

export type BuilderReport = z.infer<typeof builderReportSchema>;
export type Refusal = BuilderReport['refusals'][number];

export function parseBuilderReport(value: unknown): Parsed<BuilderReport> {
  return parseWith(builderReportSchema, value);
}

/** Whether the builder wrote a report, and whether it holds the shape. */
export type ReportState = 'valid' | 'missing' | 'invalid';

export interface ReadReport {
  state: ReportState;
  report: BuilderReport | null;
  errors: string[];
}

/** The report at `path`, validated. */
export function readBuilderReport(path: string): ReadReport {
  if (!existsSync(path)) return { state: 'missing', report: null, errors: [`the builder wrote no ${path}`] };
  const json = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = json.ok ? parseBuilderReport(json.value) : json;
  if (!parsed.ok) return { state: 'invalid', report: null, errors: parsed.errors };
  return { state: 'valid', report: parsed.value, errors: [] };
}
