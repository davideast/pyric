/**
 * One commit's check, in a fresh tree exported from the harness's repo
 * (`tree.ts`), in its own sandbox, in this order:
 *
 * 1. The UI scans on the lines changed since the start commit, with the
 *    harness's ast-grep, before anything of the commit's has run.
 * 2. The install (`studio-install.ts`).
 * 3. Studio's start, and the walks from the walk sandbox. The agent's tests
 *    have not run yet, so nothing they do can shape what the walks see.
 * 4. Studio's typecheck, tests and ast-grep checks.
 *
 * The hourly check and the baseline both run it, so the start commit's
 * captures come from the same path as every hour's.
 */
import type { AppPaths } from './app-paths.ts';
import type { AppRecord } from './app-setup.ts';
import { staticGates, startAndWalk, type WalkJobSpec, type WalkRun } from './app-gates.ts';
import { Aborted, type Runner } from './exec.ts';
import { skipped, type GateResult } from './gates.ts';
import { showFile } from './git.ts';
import { openSandbox as realSandbox, specAt, type SandboxOpener } from './sandbox.ts';
import { optional } from './optional.ts';
import { bunCacheDir, installStudio } from './studio-install.ts';
import { AST_GREP, FFMPEG, verifiedTool } from './tools.ts';
import { exportTree, unpackTree } from './tree.ts';
import { runUiGates, type UiGateInput, type UiGateResult } from './ui-gates.ts';

export type UiScan = Omit<UiGateInput, 'runner' | 'astGrep' | 'repo' | 'readSource'>;

export interface TreeCheckInput {
  paths: AppPaths;
  record: AppRecord;
  commit: string;
  /** Names the tree's directory in `<run>.work/`. */
  label: string;
  /** Where Studio's log and the allowlist log go, in the run's host directory. */
  logDir: string;
  jobs: readonly WalkJobSpec[];
  /** The UI scans to run first; none for the baseline. */
  ui?: UiScan;
  signal?: AbortSignal;
  openSandbox?: SandboxOpener;
  say: (line: string) => void;
}

export interface TreeCheck {
  statics: GateResult[];
  walked: WalkRun;
  ui?: UiGateResult;
  /** Why the UI scans failed to run, when they did. */
  uiError?: string;
}

const STATIC_GATES = ['typecheck', 'tests', 'studio-checks'] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every gate failed by one step that broke before them; the step's whole error goes in each gate's log. */
function brokenBefore(step: string, error: unknown): TreeCheck {
  const text = errorText(error);
  const why = `${step} failed: ${text.split('\n')[0] ?? ''}`;
  const failed = (gate: GateResult['gate']): GateResult => ({ ...skipped(gate, why), output: text });
  const walked: WalkRun = { appStart: failed('app-start'), walks: failed('walks'), results: new Map() };
  return { statics: STATIC_GATES.map(failed), walked };
}

async function scanFirst(input: TreeCheckInput, runner: Runner, astGrep: string, repo: string): Promise<Pick<TreeCheck, 'ui' | 'uiError'>> {
  if (input.ui === undefined) return {};
  const readSource = (file: string) => showFile(input.paths.gitDir, input.commit, file);
  try {
    return { ui: await runUiGates({ ...input.ui, runner, astGrep, repo, readSource }) };
  } catch (error) {
    if (input.signal?.aborted === true) throw new Aborted('the check was stopped during the UI scans');
    return { uiError: errorText(error) };
  }
}

export async function runTreeCheck(input: TreeCheckInput): Promise<TreeCheck> {
  const { paths, record } = input;
  const opener = input.openSandbox ?? realSandbox;
  const astGrep = verifiedTool(paths.tools, record.tools, AST_GREP);
  const hasFfmpeg = record.tools[FFMPEG] !== undefined;
  const ffmpeg = hasFfmpeg ? verifiedTool(paths.tools, record.tools, FFMPEG) : undefined;
  const checkout = exportTree(paths, input.commit, input.label);
  const spec = { ...specAt(checkout.root, input.signal, [record.briefDir]), overlaid: [bunCacheDir()] };
  return opener(spec, paths, async (runner, namespace) => {
    await unpackTree(runner, checkout);
    const scanned = await scanFirst(input, runner, astGrep, checkout.repo);
    const withUi = (check: TreeCheck): TreeCheck => ({ ...check, ...scanned });
    try {
      await installStudio({ runner, namespace, checkout, withRoot: true, say: input.say });
    } catch (error) {
      if (input.signal?.aborted === true) throw new Aborted('the check was stopped during the install');
      return withUi(brokenBefore('the install', error));
    }
    const walked = await startAndWalk({ paths, runner, namespace, checkout, openSandbox: opener, briefDir: record.briefDir, logDir: input.logDir, jobs: input.jobs, ...optional('signal', input.signal) });
    const statics = await staticGates(runner, checkout, { astGrep, ...optional('ffmpeg', ffmpeg) });
    return withUi({ statics, walked });
  });
}
