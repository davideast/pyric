// `round` end to end with the fake builder (fixtures/fake-builder.mjs), no
// model and no spend: the real harness command, each run in its own sandbox,
// with the packed packages installed into the starter app. It needs packed
// tarballs, so it runs only when PYRIC_BUILDERS_PACKAGES names their
// directory (`bash scripts/pack-packages.sh` writes them to dist/packages):
//
//   PYRIC_BUILDERS_PACKAGES=dist/packages bun test ./test/builders/round-fake-builder.test.ts
//
// Scratch and run data go to a temporary directory, never ~/pyric-builders
// or pyric-ops.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readMeasurements } from './measurement.ts';
import type { RunRecord } from './run-record.ts';

const PACKAGES = process.env.PYRIC_BUILDERS_PACKAGES;
const REPO_ROOT = resolve(import.meta.dir, '../..');
const ROUND_TIMEOUT_MS = 900_000;
const MODELS = ['fake-haiku', 'fake-sonnet'];

function runFakeRound(root: string) {
  const args = [
    'test/builders/harness.ts', 'round', 'fake',
    '--builder', 'test/builders/fixtures/fake-builder.mjs',
    '--briefs', 'test/builders/fixtures/briefs',
    '--models', MODELS.join(','),
    '--max-budget-usd', '0.01',
    '--packages', resolve(PACKAGES ?? ''),
  ];
  const env = { ...process.env, PYRIC_BUILDERS_DIR: join(root, 'scratch'), PYRIC_BUILDERS_DATA_DIR: join(root, 'data') };
  return spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: ROUND_TIMEOUT_MS });
}

describe.skipIf(PACKAGES === undefined)('round with the fake builder', () => {
  test('runs the brief once per model in a sandbox, records every planted request, and keeps the run data', () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-round-'));
    const result = runFakeRound(root);
    console.log(result.stdout, result.stderr);
    expect(result.status).toBe(0);

    for (const model of MODELS) {
      const run = `fake-1-${model}`;
      const data = join(root, 'data', 'runs', 'fake', run);
      expect(readdirSync(data).sort()).toEqual(['app.tgz', 'brief.json', 'logs', 'network.jsonl', 'report.json']);
      const record = JSON.parse(readFileSync(join(data, 'report.json'), 'utf8')) as RunRecord;
      expect(record.builder?.refusals.map((refusal) => refusal.result)).toEqual(['allowed', 'refused']);
      expect(record.harness).toMatchObject({ run, model, maxBudgetUsd: 0.01, report: { state: 'valid' }, missingRefusals: [], exit: { code: 0, timedOut: false } });
      expect(record.harness.usage).toMatchObject({ costUsd: 0, ending: 'success' });
      const google = record.harness.automaticProblems.flatMap((problem) => (problem.kind === 'google-host' ? [`${problem.host} ${problem.layers.join('+')}`] : []));
      expect(google).toEqual(expect.arrayContaining(['firebasestorage.googleapis.com browser', 'oauth2.googleapis.com model-channel']));
      expect(google.some((line) => line.startsWith('firestore.googleapis.com ') && line.includes('node'))).toBe(true);
      expect(record.harness.automaticProblems.filter((problem) => problem.kind === 'refusal-allowed')).toHaveLength(1);
      expect(record.harness.network.browserIncomplete).toBe(false);

      const log = readFileSync(join(data, 'logs', 'builder.log'), 'utf8');
      const plants = JSON.parse(log.split('\n').find((line) => line.startsWith('{"plants"')) ?? '{}') as { plants: Record<string, string> };
      expect(plants.plants.node).toStartWith('failed');
      expect(plants.plants.channel).toBe('HTTP/1.1 403 Forbidden');
      expect(plants.plants.browser).toStartWith('failed');

      const scratch = join(root, 'scratch', 'fake', run);
      expect(readdirSync(join(scratch, 'docs', 'conformance')).length).toBeGreaterThan(0);
      expect(existsSync(join(scratch, 'docs', 'site', 'overview.md'))).toBe(true);
    }

    const { lines, errors } = readMeasurements(join(root, 'data', 'measurements.jsonl'));
    expect(errors).toEqual([]);
    expect(lines.map((line) => line.kind === 'builder' && line.model).sort()).toEqual(MODELS);
  }, ROUND_TIMEOUT_MS);
});
