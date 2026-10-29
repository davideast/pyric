// Open-or-update helpers for the scheduled CI lanes that file one issue and
// keep it current. `sdk-drift.ts` files one per package and major;
// `oracle-leg-report.ts` files one for the weekly oracle re-capture. Both go
// through `gh`, which the workflow authenticates with GH_TOKEN.

import { spawnSync } from 'node:child_process';

/** Runs `gh` with `args` and returns its stdout. Throws when `gh` fails. */
export type Gh = (args: string[]) => string;

export interface IssueFiling {
  /** Every title this issue has had starts with this prefix. */
  prefix: string;
  title: string;
  label: string;
  /** A Markdown file: the body of a new issue, or the comment on an open one. */
  bodyFile: string;
}

export function spawnGh(cwd: string): Gh {
  return (args) => {
    const out = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed: ${out.stderr}`);
    return out.stdout;
  };
}

/** The number of the open issue whose title starts with `prefix`. */
export function findOpenIssue(gh: Gh, prefix: string): number | undefined {
  const issues = JSON.parse(gh([
    'issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title',
    '--search', `"${prefix}" in:title`,
  ])) as { number: number; title: string }[];
  return issues.find((issue) => issue.title.startsWith(prefix))?.number;
}

/** Opens the issue, or comments the body file on the open one and then retitles
 *  it. The comment goes first, so a failed retitle cannot lose the week's
 *  table; the retitle failure then fails the step, naming the issue.
 *  Returns what `gh` printed: the new issue's URL or the comment's URL. */
export function openOrUpdateIssue(gh: Gh, filing: IssueFiling): string {
  const existing = findOpenIssue(gh, filing.prefix);
  if (existing === undefined) {
    return gh(['issue', 'create', '--title', filing.title, '--label', filing.label, '--body-file', filing.bodyFile]).trim();
  }
  const commented = gh(['issue', 'comment', String(existing), '--body-file', filing.bodyFile]).trim();
  retitleIssue(gh, existing, filing.title);
  return commented;
}

function retitleIssue(gh: Gh, number: number, title: string): void {
  try {
    gh(['issue', 'edit', String(number), '--title', title]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Commented on #${number}, but retitling it failed: ${reason}`);
  }
}

/** Comments the body file on the open issue, then closes it. Returns the
 *  number closed, or undefined when no issue was open. */
export function closeOpenIssue(gh: Gh, prefix: string, bodyFile: string): number | undefined {
  const existing = findOpenIssue(gh, prefix);
  if (existing === undefined) return undefined;
  gh(['issue', 'comment', String(existing), '--body-file', bodyFile]);
  gh(['issue', 'close', String(existing)]);
  return existing;
}
