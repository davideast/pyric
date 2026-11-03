/**
 * The last good commit: the newest one that passed every gate of an hourly
 * check, recorded in `last-good.json`. What the served copy shows is a
 * separate choice (`serveAction`): the newest servable commit, one that
 * passed the serve gates (`SERVE_GATES` in `gates.ts`), recorded in
 * `last-served.json` (`last-served.ts`). A commit that isn't servable
 * changes nothing. A servable one restarts the served copy when it is new,
 * or starts it when nothing serves (after a reboot, say).
 */
import { z } from 'zod';
import { readJson, writeJson } from './state-files.ts';

const lastGoodSchema = z.object({
  commit: z.string(),
  hour: z.number().int(),
  at: z.string().datetime(),
}).strict();

export type LastGood = z.infer<typeof lastGoodSchema>;

export function readLastGood(path: string): LastGood | undefined {
  return readJson(path, lastGoodSchema);
}

export function writeLastGood(path: string, value: LastGood): void {
  writeJson(path, value);
}

export type ServeAction = 'restart' | 'start' | 'leave';

export interface ServeInput {
  /** The commit served last, from `last-served.json`. */
  previous: { commit: string } | undefined;
  /** Whether this hour's commit met the serve minimum. */
  servable: boolean;
  commit: string;
  /** Whether the served copy is up now. */
  serving: boolean;
}

export function serveAction(input: ServeInput): ServeAction {
  if (!input.servable) return 'leave';
  const isNewCommit = input.previous?.commit !== input.commit;
  if (isNewCommit) return 'restart';
  return input.serving ? 'leave' : 'start';
}
