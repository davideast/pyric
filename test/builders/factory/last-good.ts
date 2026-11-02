/**
 * The last good commit: the newest one an hourly check passed, which the
 * tailnet address serves. A failing hour changes nothing. A passing hour
 * records its commit, and restarts the served copy only when the commit is
 * new, or starts it when nothing serves (after a reboot, say).
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeJsonFile } from './run-dir.ts';

const lastGoodSchema = z.object({
  commit: z.string(),
  hour: z.number().int(),
  at: z.string().datetime(),
}).strict();

export type LastGood = z.infer<typeof lastGoodSchema>;

export function readLastGood(path: string): LastGood | undefined {
  if (!existsSync(path)) return undefined;
  return lastGoodSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeLastGood(path: string, value: LastGood): void {
  writeJsonFile(path, value);
}

export type ServeAction = 'restart' | 'start' | 'leave';

export interface ServeInput {
  previous: LastGood | undefined;
  passed: boolean;
  commit: string;
  /** Whether the served copy is up now. */
  serving: boolean;
}

export function serveAction(input: ServeInput): ServeAction {
  if (!input.passed) return 'leave';
  const isNewCommit = input.previous?.commit !== input.commit;
  if (isNewCommit) return 'restart';
  return input.serving ? 'leave' : 'start';
}
