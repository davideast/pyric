/**
 * The layout gate: a layout finding fails the check only when the start
 * commit's capture of the same page at the same width didn't have it, so
 * Studio's existing layout problems never fail an hour. A page the walks
 * visit that couldn't be captured fails it too.
 */
import type { LayoutFinding } from './layout-probe.ts';
import type { PageCapture } from './walk-runner.ts';

export interface LayoutProblem {
  path: string;
  width: number;
  rule: LayoutFinding['rule'] | 'capture-failed';
  detail: string;
}

function findingKey(path: string, width: number, finding: LayoutFinding): string {
  return `${path}|${width}|${finding.rule}|${finding.key}`;
}

export function newLayoutProblems(after: readonly PageCapture[], before: readonly PageCapture[]): LayoutProblem[] {
  const known = new Set(before.flatMap((page) => page.findings.map((finding) => findingKey(page.path, page.width, finding))));
  const problems: LayoutProblem[] = [];
  for (const page of after) {
    if (page.error !== undefined) problems.push({ path: page.path, width: page.width, rule: 'capture-failed', detail: page.error.split('\n')[0] ?? '' });
    for (const finding of page.findings) {
      if (known.has(findingKey(page.path, page.width, finding))) continue;
      problems.push({ path: page.path, width: page.width, rule: finding.rule, detail: finding.detail });
    }
  }
  return problems;
}
