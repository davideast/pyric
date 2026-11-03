/**
 * What the served copy shows, in `last-served.json`: the commit, the hour
 * and time it was served or last checked, the gates it fails (its label),
 * and the commit subjects since the commit served before it, or since the
 * run's start commit for the first one. The served copy's status page
 * (`status-page.ts`) reads it on each request, so a new label shows there
 * without a restart.
 *
 * The subjects come from the harness's bare repo. Sessions write them, so
 * they are cut to a fixed count and length here, and escaped where shown.
 */
import { z } from 'zod';
import { GATES, type GateName } from './gates.ts';
import { bareGit } from './git.ts';
import { readJson, writeJson } from './state-files.ts';

export const MAX_CHANGES = 50;
const MAX_SUBJECT = 200;

const lastServedSchema = z.object({
  commit: z.string(),
  hour: z.number().int(),
  at: z.string().datetime(),
  failing: z.array(z.enum(GATES)),
  /** The commit the changes are counted from. */
  since: z.object({ commit: z.string(), what: z.enum(['previous', 'start']) }).strict(),
  /** Commit subjects since then, newest first; absent when git could not list them. */
  changes: z.array(z.string()).optional(),
}).strict();

export type LastServed = z.infer<typeof lastServedSchema>;

export function readLastServed(path: string): LastServed | undefined {
  return readJson(path, lastServedSchema);
}

export function writeLastServed(path: string, value: LastServed): void {
  writeJson(path, value);
}

/** The subjects of the commits after `since` up to `commit`, newest first; undefined when git can't say. */
export function changesSince(gitDir: string, since: string, commit: string): string[] | undefined {
  try {
    const out = bareGit(gitDir, ['log', '--format=%s', `--max-count=${MAX_CHANGES}`, `${since}..${commit}`]);
    return out.split('\n').filter((line) => line !== '').map((line) => line.slice(0, MAX_SUBJECT));
  } catch {
    return undefined;
  }
}

export interface Serving {
  commit: string;
  hour: number;
  at: string;
  failing: readonly GateName[];
}

/** Where a newly served commit counts its changes from: the commit served before it, else the run's start. */
export function sinceOf(previous: LastServed | undefined, startCommit: string): LastServed['since'] {
  if (previous === undefined) return { commit: startCommit, what: 'start' };
  return { commit: previous.commit, what: 'previous' };
}

function isSameCommit(previous: LastServed | undefined, commit: string): previous is LastServed {
  return previous?.commit === commit;
}

/** The record for `serving`. The same commit served again keeps its changes; only the label and time move. */
export function nextLastServed(previous: LastServed | undefined, serving: Serving, startCommit: string, gitDir: string): LastServed {
  const base = { commit: serving.commit, hour: serving.hour, at: serving.at, failing: [...serving.failing] };
  if (isSameCommit(previous, serving.commit)) return { ...previous, ...base };
  const since = sinceOf(previous, startCommit);
  const changes = changesSince(gitDir, since.commit, serving.commit);
  return { ...base, since, ...(changes === undefined ? {} : { changes }) };
}
