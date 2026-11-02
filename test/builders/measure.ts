/**
 * The `measure` summary: per builder model, what a run costs and what it
 * finds, from `measurements.jsonl`. A run counts toward the finding figures
 * only once the verifier has judged it; until then it counts only toward the
 * builder's cost.
 *
 * A run's builder cost is what the model forwarder metered, which errs
 * high. What claude printed is in the run's `report.json`, but the builder
 * can write that file, so the measurement doesn't take it.
 *
 * - cost per builder run: the mean builder cost of every run.
 * - cost per verifier report: the mean verification cost of judged runs.
 * - confirmed new findings per app: confirmed problems (pyric differs,
 *   misleading docs, unclear error; not duplicates) per judged run.
 * - throw-out share: of the problems judged runs reported, the share the
 *   verifier threw out (unconfirmed, builder's own bug, invalid run).
 *   Duplicates and needs-capture are kept, not thrown out. The verifier
 *   gives every reported problem one verdict, so the problems reported are
 *   its verdicts' total.
 * - cost per confirmed new finding: builder plus verification cost of the
 *   judged runs, over their confirmed new findings.
 *
 * The nightly model is the one with the lower cost per confirmed new finding.
 * The nightly cap is runs per night times the 90th-percentile cost of one of
 * its judged runs plus that run's verification.
 */
import type { BuilderMeasurement, Measurement, VerdictCounts, VerificationMeasurement } from './measurement.ts';

export interface ModelSummary {
  model: string;
  runs: number;
  judgedRuns: number;
  costPerBuilderRun: number | null;
  costPerVerifierReport: number | null;
  confirmedNewFindings: number;
  confirmedNewFindingsPerApp: number | null;
  throwOutShare: number | null;
  costPerConfirmedNewFinding: number | null;
  /** The 90th-percentile cost of a judged run plus its verification. */
  p90RunCost: number | null;
}

export interface MeasureSummary {
  models: ModelSummary[];
  nightlyModel: string | null;
  nightlyCapUsd: number | null;
  /** Verification lines whose run has no builder line, as `<round>/<run>`. */
  orphanVerifications: string[];
}

interface JudgedRun {
  builder: BuilderMeasurement;
  verification: VerificationMeasurement;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]) => (values.length === 0 ? null : sum(values) / values.length);
const ratio = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator);

/** The nearest-rank percentile of `values`, or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(rank, 1) - 1] ?? null;
}

export function confirmedNew(verdicts: VerdictCounts): number {
  const { pyricDiffers, misleadingDocs, unclearError } = verdicts.confirmed;
  return pyricDiffers + misleadingDocs + unclearError;
}

export function thrownOut(verdicts: VerdictCounts): number {
  return verdicts.unconfirmed + verdicts.builderBug + verdicts.invalid;
}

/** Every problem the verifier judged: one verdict each. */
export function judgedProblems(verdicts: VerdictCounts): number {
  return confirmedNew(verdicts) + verdicts.duplicate + verdicts.needsCapture + thrownOut(verdicts);
}

/** What a builder run cost: what the forwarder metered. */
export const builderCost = (run: BuilderMeasurement) => run.meteredCostUsd;

/** Run ids repeat across rounds, so a verification joins its builder line by both. */
const runKey = (line: { round: string; run: string }) => `${line.round}/${line.run}`;

function summarizeModel(model: string, runs: readonly BuilderMeasurement[], judged: readonly JudgedRun[]): ModelSummary {
  const confirmed = sum(judged.map((run) => confirmedNew(run.verification.verdicts)));
  const reported = sum(judged.map((run) => judgedProblems(run.verification.verdicts)));
  const runCosts = judged.map((run) => builderCost(run.builder) + run.verification.costUsd);
  return {
    model,
    runs: runs.length,
    judgedRuns: judged.length,
    costPerBuilderRun: mean(runs.map(builderCost)),
    costPerVerifierReport: mean(judged.map((run) => run.verification.costUsd)),
    confirmedNewFindings: confirmed,
    confirmedNewFindingsPerApp: ratio(confirmed, judged.length),
    throwOutShare: ratio(sum(judged.map((run) => thrownOut(run.verification.verdicts))), reported),
    costPerConfirmedNewFinding: ratio(sum(runCosts), confirmed),
    p90RunCost: percentile(runCosts, 90),
  };
}

/** The model with the lowest cost per confirmed new finding; none when no model has confirmed one. */
function cheapestPerFinding(models: readonly ModelSummary[]): ModelSummary | undefined {
  const finding = models.filter((model) => model.costPerConfirmedNewFinding !== null);
  return [...finding].sort((a, b) => (a.costPerConfirmedNewFinding ?? 0) - (b.costPerConfirmedNewFinding ?? 0))[0];
}

/** Runs per night times the nightly model's p90 run cost; null without either. */
function nightlyCap(model: ModelSummary | undefined, runsPerNight: number | undefined): number | null {
  const p90 = model?.p90RunCost ?? null;
  if (runsPerNight === undefined || p90 === null) return null;
  return runsPerNight * p90;
}

export function summarize(lines: readonly Measurement[], options: { runsPerNight?: number } = {}): MeasureSummary {
  const builders = lines.filter((line): line is BuilderMeasurement => line.kind === 'builder');
  const verifications = new Map(lines.filter((line): line is VerificationMeasurement => line.kind === 'verification').map((line) => [runKey(line), line]));
  const runKeys = new Set(builders.map(runKey));
  const models = [...new Set(builders.map((run) => run.model))].sort().map((model) => {
    const runs = builders.filter((run) => run.model === model);
    const judged = runs.flatMap((builder) => {
      const verification = verifications.get(runKey(builder));
      return verification === undefined ? [] : [{ builder, verification }];
    });
    return summarizeModel(model, runs, judged);
  });
  const nightly = cheapestPerFinding(models);
  return {
    models,
    nightlyModel: nightly?.model ?? null,
    nightlyCapUsd: nightlyCap(nightly, options.runsPerNight),
    orphanVerifications: [...verifications.keys()].filter((key) => !runKeys.has(key)).sort(),
  };
}

const dollars = (value: number | null) => (value === null ? '-' : `$${value.toFixed(2)}`);
const share = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);
const decimal = (value: number | null) => (value === null ? '-' : value.toFixed(2));

/** The summary as a table, one row per model, then the nightly choice. */
export function formatSummary(summary: MeasureSummary): string {
  const header = ['model', 'runs', 'judged', 'cost/run', 'cost/verify', 'new findings/app', 'thrown out', 'cost/new finding', 'p90 run'];
  const rows = summary.models.map((model) => [
    model.model, String(model.runs), String(model.judgedRuns), dollars(model.costPerBuilderRun), dollars(model.costPerVerifierReport),
    decimal(model.confirmedNewFindingsPerApp), share(model.throwOutShare), dollars(model.costPerConfirmedNewFinding), dollars(model.p90RunCost),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  const nightly = summary.nightlyModel === null ? 'nightly model: none yet (no model has a confirmed new finding)' : `nightly model: ${summary.nightlyModel}`;
  const cap = summary.nightlyCapUsd === null ? [] : [`nightly cap: ${dollars(summary.nightlyCapUsd)}`];
  const orphans = summary.orphanVerifications.length === 0 ? [] : [`verifications with no builder run: ${summary.orphanVerifications.join(', ')}`];
  return [line(header), ...rows.map(line), '', nightly, ...cap, ...orphans].join('\n');
}
