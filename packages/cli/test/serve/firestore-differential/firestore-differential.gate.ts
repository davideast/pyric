/**
 * Fast PR gate for the seeded Firestore differential runner: runs saved
 * regression fixtures plus a deterministic seed slice across the in-process
 * `pyric/firestore` sandbox (`sandbox`) and the real hosted `@pyric/cli`
 * HTTP/WebSocket serve plane (`hosted`), asserting identical step outcomes,
 * live-listener snapshots + `docChanges()`, quiescent client state, Admin
 * `RemoteSandbox` cross-reads, and bundle round-trip equivalence.
 *
 * Replay any single seed or custom sweep via environment variables:
 *   PYRIC_FS_DIFF_SEED=42 bun test --cwd packages/cli ./test/serve/firestore-differential/firestore-differential.gate.ts
 *   PYRIC_FS_DIFF_SEED=1 PYRIC_FS_DIFF_SEEDS=500 bun test --cwd packages/cli ./test/serve/firestore-differential/firestore-differential.gate.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createPlaneRunner,
  formatFailureReport,
  readFixtures,
  runAll,
  shrink,
  type PlaneRunner,
  type Verdict,
} from './differential.js';
import { generateSequence, type GenerateOptions } from './generator.js';
import { KNOWN_DIVERGENCES } from './known-divergences.js';
import type { PlaneName } from './planes.js';
import type { Sequence } from './sequence.js';

const PLANES: readonly PlaneName[] = ['sandbox', 'hosted'];

const DEFAULT_PR_START = 1;
const DEFAULT_PR_COUNT = 36;

function resolveSeedConfig(): { start: number; count: number; fixedSteps?: number; singleReplay: boolean } {
  const envSeed = process.env.PYRIC_FS_DIFF_SEED;
  const envCount = process.env.PYRIC_FS_DIFF_SEEDS;
  const envSteps = process.env.PYRIC_FS_DIFF_STEPS;

  let start = DEFAULT_PR_START;
  if (envSeed !== undefined) {
    start = Number(envSeed);
  }
  let count = DEFAULT_PR_COUNT;
  if (envCount !== undefined) {
    count = Number(envCount);
  } else if (envSeed !== undefined) {
    count = 1;
  }

  const out: { start: number; count: number; fixedSteps?: number; singleReplay: boolean } = {
    start,
    count,
    singleReplay: envSeed !== undefined,
  };
  if (envSteps !== undefined) {
    out.fixedSteps = Number(envSteps);
  }
  return out;
}

const CONFIG = resolveSeedConfig();
let runner: PlaneRunner;
let fixtureVerdicts: Verdict[] = [];
let seedVerdicts: Verdict[] = [];

beforeAll(async () => {
  const chunks = Number(process.env.PYRIC_FS_DIFF_CHUNKS ?? 2);
  runner = await createPlaneRunner({ chunks });

  let fixtureSequences: Sequence[] = [];
  if (!CONFIG.singleReplay) {
    fixtureSequences = readFixtures(join(import.meta.dir, 'fixtures'));
  }

  const genOpts: GenerateOptions = {};
  if (CONFIG.fixedSteps !== undefined) {
    genOpts.minSteps = CONFIG.fixedSteps;
    genOpts.maxSteps = CONFIG.fixedSteps;
  }
  const seedSequences = Array.from(
    { length: CONFIG.count },
    (_, index) => generateSequence(CONFIG.start + index, genOpts),
  );

  // Execute fixtures and PR seeds in a single batch so each worker chunk pays
  // `startServe` startup once rather than twice.
  const combined = await runAll(runner, PLANES, [...fixtureSequences, ...seedSequences]);
  fixtureVerdicts = combined.slice(0, fixtureSequences.length);
  seedVerdicts = combined.slice(fixtureSequences.length);
}, 120_000);

afterAll(() => {
  runner?.dispose();
});

async function collectFailures(verdicts: readonly Verdict[], fixedSteps?: number): Promise<string[]> {
  const failures: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.mismatch === null) {
      continue;
    }
    const shrunk = await shrink(runner, PLANES, verdict);
    failures.push(formatFailureReport(verdict, shrunk, fixedSteps));
  }
  return failures;
}

describe('Firestore differential', () => {
  test('every saved fixture agrees on sandbox and hosted planes, apart from the pinned divergence it reproduces', async () => {
    if (fixtureVerdicts.length === 0) {
      return;
    }
    const failures = await collectFailures(fixtureVerdicts);
    expect(failures).toEqual([]);
    const reproduced = new Set(fixtureVerdicts.flatMap((verdict) => verdict.tolerated));
    const unreproduced = KNOWN_DIVERGENCES
      .map((divergence) => divergence.name)
      .filter((name) => !reproduced.has(name));
    expect(unreproduced).toEqual([]);
  }, 60_000);

  test(`seeds ${CONFIG.start} to ${CONFIG.start + CONFIG.count - 1} agree on sandbox and hosted planes`, async () => {
    const failures = await collectFailures(seedVerdicts, CONFIG.fixedSteps);
    expect(failures).toEqual([]);
  }, 120_000);
});
