// Which quarantine entries a run may honour. Quarantine is off unless the
// runner is given the `--quarantine` flag, which only the four CI test steps
// in build.yml pass (QUARANTINE_FLAG). No environment variable can turn it on:
// bun loads `.env` files from its working directory into process.env, so a
// switch there could be set by a file in the checkout. A publish, a local run
// and every other caller of the runners keep their old exit codes. Once on,
// a pull request honours only the entries
// on its base branch, which the plan job reads (scripts/ci/quarantine-base.ts),
// so it cannot quarantine the test it breaks. A push to main honours main's
// tree. Any other run honours none.

import { readEntries, type LoadedEntry } from './entries.ts';

/** The runner flag that turns quarantine on. */
export const QUARANTINE_FLAG = '--quarantine';
export const BASE_ENTRIES_VAR = 'PYRIC_QUARANTINE_BASE_ENTRIES';

/** Whether the flag is among the runner's own arguments, and those
 *  arguments without it. */
export function takeQuarantineFlag(args: readonly string[]): { quarantine: boolean; rest: string[] } {
  return { quarantine: args.includes(QUARANTINE_FLAG), rest: args.filter((arg) => arg !== QUARANTINE_FLAG) };
}

/** The base branch's entries as the plan job printed them. Anything but a
 *  list of objects with a file name holds none. */
export function parseBaseEntries(text: string): LoadedEntry[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LoadedEntry => typeof item === 'object' && item !== null && typeof (item as LoadedEntry).file === 'string');
  } catch {
    console.error(`quarantine: ${BASE_ENTRIES_VAR} is not JSON, so no entry is honoured`);
    return [];
  }
}

/** The entries a run with quarantine on honours. */
export function runEntries(env: NodeJS.ProcessEnv, readTree: () => LoadedEntry[] = readEntries): LoadedEntry[] {
  const isMainPush = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main';
  if (isMainPush) return readTree();
  const isPullRequest = env.GITHUB_EVENT_NAME === 'pull_request';
  const base = env[BASE_ENTRIES_VAR];
  const hasBase = base !== undefined && base.trim() !== '';
  if (isPullRequest && hasBase) return parseBaseEntries(base);
  return [];
}
