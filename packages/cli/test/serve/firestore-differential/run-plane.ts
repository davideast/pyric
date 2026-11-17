/**
 * Executes a batch of JSON sequences on one plane (`sandbox` or `hosted`) in a
 * dedicated child process and writes the resulting `PlaneOutcome[]` JSON.
 *
 *   run-plane <sandbox|hosted> <sequences.json> <traces.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { Trace } from './compare.js';
import { runSequence } from './interpreter.js';
import { openPlanePool, type PlaneName, type PlanePool } from './planes.js';
import type { Sequence } from './sequence.js';

const SEQUENCE_TIMEOUT_MS = 20_000;

export type PlaneOutcome = Trace | { seed: number; fatal: string };

async function runOne(pool: PlanePool, sequence: Sequence): Promise<PlaneOutcome> {
  const session = await pool.openSession();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sequence ${sequence.seed} timed out after ${SEQUENCE_TIMEOUT_MS} ms`)),
        SEQUENCE_TIMEOUT_MS,
      );
    });
    return await Promise.race([runSequence(sequence, session), timeout]);
  } catch (error) {
    const stack = (error as Error | undefined)?.stack;
    return { seed: sequence.seed, fatal: String(stack ?? error) };
  } finally {
    clearTimeout(timer);
    await session.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const planeArg = process.argv[2];
  const inputPath = process.argv[3];
  const outputPath = process.argv[4];
  if (planeArg === undefined || inputPath === undefined || outputPath === undefined) {
    throw new Error('Usage: run-plane <sandbox|hosted> <sequences.json> <traces.json>');
  }
  const plane = planeArg as PlaneName;
  const sequences = JSON.parse(readFileSync(inputPath, 'utf8')) as Sequence[];
  const outcomes: PlaneOutcome[] = [];

  // Suppress noisy SDK console notices (such as cache no-op info) while keeping
  // real errors visible on stderr if the worker crashes.
  console.info = () => {};
  console.warn = () => {};

  const pool = await openPlanePool(plane);
  try {
    for (const sequence of sequences) {
      outcomes.push(await runOne(pool, sequence));
    }
  } finally {
    await pool.dispose();
  }

  writeFileSync(outputPath, JSON.stringify(outcomes));
  process.exit(0);
}

if (import.meta.main || process.argv[1]?.endsWith('run-plane.mjs') || process.argv[1]?.endsWith('run-plane.ts')) {
  await main();
}
