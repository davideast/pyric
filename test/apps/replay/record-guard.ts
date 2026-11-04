/**
 * Where `record.ts` refuses to run. A recording reaches a real Firebase
 * project, so it never runs in continuous integration, whatever a workflow
 * or a run file asks: a CI runner sets `CI`, and GitHub Actions sets
 * `GITHUB_ACTIONS`.
 */

/** The variables a CI runner sets. Any non-empty value refuses. */
export const CI_VARIABLES = ['CI', 'GITHUB_ACTIONS'] as const;

/** The refusal for this environment, or null where a person may record. */
export function recordingRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const set = CI_VARIABLES.filter((name) => (env[name] ?? '') !== '');
  if (set.length === 0) return null;
  return `record.ts reaches a real Firebase project, so it does not run in CI (${set.join(' and ')} ${set.length === 1 ? 'is' : 'are'} set). Record by hand, outside CI.`;
}
