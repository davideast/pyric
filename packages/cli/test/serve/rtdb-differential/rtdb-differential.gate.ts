/**
 * The RTDB differential gate: generated operation sequences and the saved
 * fixtures run on the in-page sandbox, the SharedWorker host and the Node
 * host, and every plane must record the same results, listener events and
 * final data. Divergences listed in `known-divergences.ts` are skipped; each
 * must still be reproduced by the fixture named after it, so a fix deletes the
 * entry and its fixture then has to agree on every plane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createPlaneRunner, readFixtures, runAll, type PlaneRunner } from './differential.js';
import { generateSequence } from './generator.js';
import { KNOWN_DIVERGENCES } from './known-divergences.js';
import type { PlaneName } from './planes.js';

const PLANES: PlaneName[] = ['sandbox', 'worker', 'node'];
/** The fixed seed set every change touching serve, database or rules runs. */
const SEEDS = { start: 1, count: 160 };

let runner: PlaneRunner;
beforeAll(async () => { runner = await createPlaneRunner({ chunks: 2 }); });
afterAll(() => runner?.dispose());

function describeMismatch(verdict: Awaited<ReturnType<typeof runAll>>[number]): string {
  return `seed ${verdict.sequence.seed}: ${verdict.mismatch!.where}\n${JSON.stringify(verdict.mismatch!.values, null, 1)}`;
}

describe('RTDB differential', () => {
  test('every saved fixture agrees on every plane, apart from the known divergence it reproduces', async () => {
    const directory = join(import.meta.dir, 'fixtures');
    const sequences = readFixtures(directory);
    const verdicts = await runAll(runner, PLANES, sequences);
    expect(verdicts.filter((verdict) => verdict.mismatch !== null).map(describeMismatch)).toEqual([]);
    const reproduced = new Set(verdicts.flatMap((verdict) => verdict.tolerated));
    const unreproduced = KNOWN_DIVERGENCES.map((divergence) => divergence.name).filter((name) => !reproduced.has(name));
    expect(unreproduced).toEqual([]);
  }, 60_000);

  test(`seeds ${SEEDS.start} to ${SEEDS.start + SEEDS.count - 1} agree on every plane`, async () => {
    const sequences = Array.from({ length: SEEDS.count }, (_, index) => generateSequence(SEEDS.start + index));
    const verdicts = await runAll(runner, PLANES, sequences);
    expect(verdicts.filter((verdict) => verdict.mismatch !== null).map(describeMismatch)).toEqual([]);
  }, 100_000);
});
