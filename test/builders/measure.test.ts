import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builderCost, formatSummary, percentile, summarize } from './measure.ts';
import { appendMeasurement, readMeasurements, type BuilderMeasurement } from './measurement.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'measure', 'measurements.jsonl');

function fixtureLines() {
  const { lines, errors } = readMeasurements(FIXTURE);
  expect(errors).toEqual([]);
  return lines;
}

describe('summarize', () => {
  test('gives each model its cost, findings and throw-out share, from judged runs only', () => {
    const { models } = summarize(fixtureLines());
    expect(models.map((model) => model.model)).toEqual(['haiku', 'sonnet']);
    expect(models[0]).toEqual({
      model: 'haiku',
      runs: 3,
      judgedRuns: 2,
      costPerBuilderRun: 1.5,
      costPerVerifierReport: 0.5,
      confirmedNewFindings: 2,
      confirmedNewFindingsPerApp: 1,
      throwOutShare: 0.5,
      costPerConfirmedNewFinding: 2,
      p90RunCost: 2.5,
    });
    expect(models[1]).toMatchObject({ runs: 1, judgedRuns: 1, confirmedNewFindingsPerApp: 3, throwOutShare: 0, p90RunCost: 4 });
    expect(models[1]?.costPerConfirmedNewFinding).toBeCloseTo(4 / 3, 10);
  });

  test('picks the model with the lower cost per confirmed new finding, and caps the night at runs times its p90', () => {
    const summary = summarize(fixtureLines(), { runsPerNight: 6 });
    expect(summary.nightlyModel).toBe('sonnet');
    expect(summary.nightlyCapUsd).toBe(24);
    expect(summarize(fixtureLines()).nightlyCapUsd).toBeNull();
  });

  test('names a verification whose run has no builder line in its round, and never joins across rounds', () => {
    expect(summarize(fixtureLines()).orphanVerifications).toEqual(['r1/x-9', 'r2/r1-1-sonnet']);
  });

  test('takes a run’s builder cost from what the forwarder metered', () => {
    const [first] = fixtureLines().filter((line): line is BuilderMeasurement => line.kind === 'builder');
    if (first === undefined) throw new Error('the fixture has no builder line');
    const another = { ...first, run: 'r1-8-haiku', meteredCostUsd: 4 };
    expect(builderCost(another)).toBe(4);
    expect(summarize([first, another]).models[0]?.costPerBuilderRun).toBe(2.5);
  });

  test('chooses no nightly model before any confirmed finding, and leaves unjudged figures empty', () => {
    const builderOnly = fixtureLines().filter((line) => line.kind === 'builder');
    const summary = summarize(builderOnly, { runsPerNight: 6 });
    expect(summary.nightlyModel).toBeNull();
    expect(summary.nightlyCapUsd).toBeNull();
    expect(summary.models[0]).toMatchObject({ judgedRuns: 0, costPerVerifierReport: null, throwOutShare: null, costPerConfirmedNewFinding: null, p90RunCost: null });
  });
});

describe('percentile', () => {
  test('takes the nearest rank', () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11], 90)).toBe(10);
  });
});

describe('formatSummary', () => {
  test('prints one row per model and the nightly choice', () => {
    const text = formatSummary(summarize(fixtureLines(), { runsPerNight: 6 }));
    const [header, haiku, sonnet] = text.split('\n');
    expect(header).toStartWith('model ');
    expect(haiku).toMatch(/^haiku\s+3\s+2\s+\$1\.50\s+\$0\.50\s+1\.00\s+50%\s+\$2\.00\s+\$2\.50$/);
    expect(sonnet).toMatch(/^sonnet\s+1\s+1\s+\$3\.00\s+\$1\.00\s+3\.00\s+0%\s+\$1\.33\s+\$4\.00$/);
    expect(text).toContain('\nnightly model: sonnet\nnightly cap: $24.00\nverifications with no builder run: r1/x-9, r2/r1-1-sonnet');
  });
});

describe('measurements.jsonl', () => {
  test('appends a validated line and reads it back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'builders-measure-')), 'nested', 'measurements.jsonl');
    const line = fixtureLines()[0] as BuilderMeasurement;
    appendMeasurement(path, line);
    appendMeasurement(path, { ...line, run: 'r1-9-haiku' });
    expect(readMeasurements(path).lines.map((read) => read.kind === 'builder' && read.run)).toEqual(['r1-1-haiku', 'r1-9-haiku']);
    expect(() => appendMeasurement(path, { ...line, meteredCostUsd: -1 })).toThrow();
  });

  test('names each bad line by number instead of skipping it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'builders-measure-')), 'measurements.jsonl');
    const [first] = readFileSync(FIXTURE, 'utf8').split('\n');
    writeFileSync(path, `${first}\n{"kind":"builder"}\n\nnot json\n`);
    const { lines, errors } = readMeasurements(path);
    expect(lines).toHaveLength(1);
    expect(errors[0]).toStartWith('line 2: run: Required');
    expect(errors.at(-1)).toStartWith('line 4: not JSON');
  });
});
