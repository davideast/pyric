// Which quarantine entries a run may honour. Quarantine is off unless the
// step sets PYRIC_QUARANTINE=1, which only the PR and main CI test steps in
// build.yml do, so a publish, a local run and every other caller of the
// runners keep their old exit codes. A pull request honours only the entries
// on its base branch, which the plan job reads (scripts/ci/quarantine-base.ts),
// so it cannot quarantine the test it breaks. A push to main honours main's
// tree. Any other run honours none.

import { readEntries, type LoadedEntry } from './entries.ts';

export const ENABLE_VAR = 'PYRIC_QUARANTINE';
export const BASE_ENTRIES_VAR = 'PYRIC_QUARANTINE_BASE_ENTRIES';

export function quarantineEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[ENABLE_VAR] === '1';
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

export function runEntries(env: NodeJS.ProcessEnv, readTree: () => LoadedEntry[] = readEntries): LoadedEntry[] {
  if (!quarantineEnabled(env)) return [];
  const isMainPush = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main';
  if (isMainPush) return readTree();
  const isPullRequest = env.GITHUB_EVENT_NAME === 'pull_request';
  const base = env[BASE_ENTRIES_VAR];
  const hasBase = base !== undefined && base.trim() !== '';
  if (isPullRequest && hasBase) return parseBaseEntries(base);
  return [];
}
