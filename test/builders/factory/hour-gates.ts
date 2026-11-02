/**
 * The hour's gates from what one tree's check found (`check-run.ts`): the
 * static gates, excused only by the start commit's counted failures
 * (`known-failures.ts`); app-start and walks; the UI rules and the copy
 * check on the changed lines; and the layout gate against the start
 * commit's captures (`layout-gate.ts`).
 */
import { existsSync } from 'node:fs';
import type { AppPaths } from './app-paths.ts';
import type { WalkRun } from './app-gates.ts';
import type { TreeCheck } from './check-run.ts';
import { DEFAULT_OVERRIDES_FILE, mergeOverrides, readOverrides, type CopyOverrides } from './copy-rules.ts';
import { skipped, type GateResult } from './gates.ts';
import { excuseKnown, type KnownFailures } from './known-failures.ts';
import { newLayoutProblems } from './layout-gate.ts';
import type { UiGateResult } from './ui-gates.ts';
import type { PageCapture } from './walk-runner.ts';

export function copyOverrides(paths: AppPaths): CopyOverrides {
  const base = readOverrides(DEFAULT_OVERRIDES_FILE);
  if (!existsSync(paths.copyOverrides)) return base;
  return mergeOverrides(base, readOverrides(paths.copyOverrides));
}

export function uiGateResults(ui: UiGateResult | undefined, changedFiles: number, error?: string): GateResult[] {
  if (ui === undefined) {
    const why = error ?? 'the scans did not run';
    return [{ ...skipped('ui-rules', why), output: why }, { ...skipped('copy', why), output: why }];
  }
  const ruleLines = ui.violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.message}\n  ${v.text}`);
  const copyFailures = ui.copy.filter((entry) => entry.problems.length > 0);
  const copyLines = copyFailures.map((entry) => `${entry.file}:${entry.line} ${entry.kind} "${entry.text}": ${entry.problems.join('; ')}`);
  return [
    { gate: 'ui-rules', passed: ui.violations.length === 0, summary: `${ui.violations.length} violations in ${changedFiles} changed files`, output: ruleLines.join('\n') },
    { gate: 'copy', passed: copyFailures.length === 0, summary: `${copyFailures.length} of ${ui.copy.length} new strings fail; see copy-report.md`, output: copyLines.join('\n') },
  ];
}

export function layoutGate(walked: WalkRun, before: readonly PageCapture[]): GateResult {
  if (walked.result === undefined) return skipped('layout', 'no pages were walked');
  const problems = newLayoutProblems(walked.result.pages, before);
  const lines = problems.map((problem) => `${problem.path} at ${problem.width}px, ${problem.rule}: ${problem.detail}`);
  const summary = `${problems.length} new layout problems on ${walked.result.pages.length} captures`;
  return { gate: 'layout', passed: problems.length === 0, summary, output: lines.join('\n') };
}

/** Every gate of the hour, in the order `gates.ts` lists them. */
export function hourGates(checked: TreeCheck, known: KnownFailures, changedFiles: number, before: readonly PageCapture[]): GateResult[] {
  const statics = checked.statics.map((result) => excuseKnown(result, known));
  return [...statics, checked.walked.appStart, checked.walked.walks, ...uiGateResults(checked.ui, changedFiles, checked.uiError), layoutGate(checked.walked, before)];
}
