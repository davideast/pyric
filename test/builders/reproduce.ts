/**
 * The `reproduce` command: re-runs one problem of a kept builder run, with a
 * script the verifier wrote, in a fresh copy of the builder's app on the
 * same tarballs. At most two tries, each in a new scratch directory; it stops
 * at the first that reproduces.
 *
 * Each try runs under the same rules as a round's run: its own sandbox,
 * whose phase checks the sandbox inventory before anything starts, the
 * install inside it, and the run phase (`run-phase.ts`) under the recorder
 * with the harness browser. It gets no model channel: no bridge, no
 * forwarder, no token, so nothing it starts can leave the sandbox.
 *
 * It keeps `repro.json`, the script and each try's network record and logs
 * in the run's data, and files nothing.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeHeavyRunSlot } from '../../scripts/lib/heavy-run-slots.ts';
import { runTimedCommand } from '../apps/install.ts';
import { installApp, npmCacheDir } from './app-install.ts';
import { playwrightBrowsersPath } from './browser-server.ts';
import { phaseEnvironment, readPhaseResult } from './builder-run.ts';
import { startEgressNamespace, type EgressNamespace } from './namespace.ts';
import { sha256File } from './provenance.ts';
import { browserEvents, readNetLog } from './recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from './recorder/network-record.ts';
import { layOutReproApp } from './repro-app.ts';
import { judgeTry, reproResult, type TryJudgment } from './repro-verdict.ts';
import { checkReproduce, type CheckedRepro } from './reproduce-check.ts';
import type { ReproduceOptions } from './reproduce-options.ts';
import { builderRunDirsAt, reproDataDir, reproTryRoot, type BuilderRunDirs } from './round-paths.ts';
import { googleEventsIn, googleHostProblems } from './run-record.ts';
import type { Phase, PhaseResult } from './run-phase.ts';
import { copyRedacted } from './token-scan.ts';
import { createRunDirs, runStamp } from './scratch.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUN_PHASE = fileURLToPath(new URL('./run-phase.ts', import.meta.url));
export const MAX_TRIES = 2;
export const REPRO_LOG = 'repro.log';
/** Time a try's phase gets beyond the script's cap, to start the browser and stop everything. */
const PHASE_MARGIN_MS = 300_000;

export interface TryRecord extends TryJudgment {
  attempt: number;
  scratch: string;
  exit: PhaseResult | null;
  googleHosts: string[];
}

interface ReproContext {
  options: ReproduceOptions;
  checked: CheckedRepro;
  stamp: string;
}

function say(line: string): void {
  console.log(`▸ ${line}`);
}

/** What the run phase runs for a try: node on the script, with no model channel. */
export function reproPhase(scriptName: string, options: Pick<ReproduceOptions, 'register' | 'minutes' | 'problem'>): Phase {
  const register = options.register ? ['--import', '@pyric/cli/register'] : [];
  return {
    command: 'node',
    args: [...register, scriptName],
    env: { PYRIC_REPRO_PROBLEM: options.problem },
    wallClockMs: options.minutes * 60_000,
    modelChannel: false,
    log: REPRO_LOG,
  };
}

async function runInSandbox(namespace: EgressNamespace, context: ReproContext, dirs: BuilderRunDirs): Promise<void> {
  const { checked, options } = context;
  const scriptName = await layOutReproApp({ dirs, appArchive: checked.appArchive, tarballs: checked.tarballs, run: options.run, script: options.script });
  // The app is the builder's: a cold cache ends the try, never an install on the host.
  await installApp(namespace, dirs, `${options.run} repro`, say, 'forbidden');
  const phase = reproPhase(scriptName, options);
  writeFileSync(dirs.phase, `${JSON.stringify(phase, null, 2)}\n`);
  const { command, args } = namespace.enter(process.execPath, [RUN_PHASE, dirs.root], REPO_ROOT);
  const result = await runTimedCommand(command, args, { cwd: REPO_ROOT, env: phaseEnvironment(dirs.home), timeoutMs: phase.wallClockMs + PHASE_MARGIN_MS });
  writeFileSync(join(dirs.logs, '02-repro-phase.log'), result.output);
  say(`repro phase exited ${result.code}${result.timedOut ? ' (stopped at its limit)' : ''}`);
}

/** Every Google host or metadata address in the try's network record. */
function googleHostsOf(dirs: BuilderRunDirs): string[] {
  if (existsSync(dirs.netLog)) appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
  const problems = googleHostProblems(googleEventsIn(readNetworkRecord(dirs.networkLog)));
  return problems.flatMap((problem) => (problem.kind === 'google-host' ? [problem.host] : []));
}

async function runTry(context: ReproContext, attempt: number): Promise<TryRecord> {
  const { options, checked } = context;
  const dirs = builderRunDirsAt(reproTryRoot(options.round, options.run, checked.target.slug, context.stamp, attempt));
  createRunDirs(dirs.root);
  say(`try ${attempt} of ${MAX_TRIES}: starting its sandbox in ${dirs.root}`);
  const readOnly = [playwrightBrowsersPath(), checked.packagesDir];
  const namespace = await startEgressNamespace({ networkLog: dirs.networkLog, runRoot: dirs.root, readOnly, overlaid: [npmCacheDir()] });
  try {
    await runInSandbox(namespace, context, dirs);
  } finally {
    await namespace.stop();
  }
  const exit = readPhaseResult(dirs);
  const logFile = join(dirs.logs, REPRO_LOG);
  const output = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const googleHosts = googleHostsOf(dirs);
  const judgment = judgeTry(checked.target, { exit, output, googleHosts }, options.expect);
  say(`try ${attempt}: ${judgment.outcome}, ${judgment.reason}`);
  return { attempt, scratch: dirs.root, exit, googleHosts, ...judgment };
}

/** Copies the script and each try's record and logs into the run's data, and writes `repro.json`. */
function keep(context: ReproContext, tries: readonly TryRecord[], startedAt: Date): string {
  const { options, checked, stamp } = context;
  const dataDir = reproDataDir(options.round, options.run, checked.target.slug, stamp);
  mkdirSync(dataDir, { recursive: true });
  const script = `script${extname(options.script)}`;
  copyFileSync(options.script, join(dataDir, script));
  // A copy that follows no link; the try had no token to redact.
  for (const entry of tries) {
    const dirs = builderRunDirsAt(entry.scratch);
    const kept = join(dataDir, `try-${entry.attempt}`);
    mkdirSync(kept, { recursive: true });
    copyRedacted(dirs.networkLog, join(kept, 'network.jsonl'), undefined);
    copyRedacted(dirs.logs, join(kept, 'logs'), undefined);
  }
  const { target } = checked;
  const record = {
    round: options.round,
    run: options.run,
    problem: target.selector,
    kind: target.kind,
    script: { file: script, sha256: sha256File(options.script) },
    expect: options.expect ?? null,
    register: options.register,
    minutesPerTry: options.minutes,
    provenance: checked.kept.harness.provenance,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    tries,
    result: reproResult(tries.map((entry) => entry.outcome)),
  };
  writeFileSync(join(dataDir, 'repro.json'), `${JSON.stringify(record, null, 2)}\n`);
  return dataDir;
}

/** Runs the reproduction. Resolves true when a try reproduced the problem. */
export async function runReproduce(options: ReproduceOptions): Promise<boolean> {
  const checked = checkReproduce(options);
  const context: ReproContext = { options, checked, stamp: runStamp() };
  say(`reproducing ${checked.target.selector} of run ${options.run}, round ${options.round}: up to ${MAX_TRIES} tries, ${options.minutes} minutes each, no model channel`);
  const slot = await takeHeavyRunSlot({ command: `bun test/builders/harness.ts reproduce ${options.round} ${options.run} ${checked.target.selector}`, env: { ...process.env } });
  const startedAt = new Date();
  const tries: TryRecord[] = [];
  try {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      const entry = await runTry(context, attempt);
      tries.push(entry);
      if (entry.outcome === 'reproduced') break;
    }
  } finally {
    slot.release();
  }
  const dataDir = keep(context, tries, startedAt);
  const result = reproResult(tries.map((entry) => entry.outcome));
  say(`${checked.target.selector}: ${result} after ${tries.length} ${tries.length === 1 ? 'try' : 'tries'}; kept in ${dataDir}`);
  return result === 'reproduced';
}
