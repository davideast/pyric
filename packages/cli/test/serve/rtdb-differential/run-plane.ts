/**
 * Runs sequences on one plane in its own process and writes their traces.
 *
 *   run-plane <sandbox|worker|node> <sequences.json> <traces.json>
 *
 * Each plane runs in its own process because the served entries choose their
 * transport when they are evaluated.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runSequence, type Trace } from './interpreter.js';
import { openPlane, type PlaneName } from './planes.js';
import type { Sequence } from './sequence.js';

const SEQUENCE_TIMEOUT_MS = 15_000;

export type PlaneOutcome = Trace | { seed: number; fatal: string };

async function runOne(plane: PlaneName, sequence: Sequence): Promise<PlaneOutcome> {
  const session = await openPlane(plane);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sequence timed out after ${SEQUENCE_TIMEOUT_MS} ms`)), SEQUENCE_TIMEOUT_MS);
    });
    return await Promise.race([runSequence(sequence, session), timeout]);
  } catch (error) {
    return { seed: sequence.seed, fatal: String((error as Error)?.stack ?? error) };
  } finally {
    clearTimeout(timer);
    await session.close().catch(() => undefined);
  }
}

const [plane, input, output] = process.argv.slice(2) as [PlaneName, string, string];
const sequences = JSON.parse(readFileSync(input, 'utf8')) as Sequence[];
const outcomes: PlaneOutcome[] = [];
// The served client logs SDK warnings, such as unindexed queries; the trace,
// not the console, is what the runner compares.
console.warn = () => {};
for (const sequence of sequences) outcomes.push(await runOne(plane, sequence));
writeFileSync(output, JSON.stringify(outcomes));
process.exit(0);
