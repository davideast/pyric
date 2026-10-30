/**
 * One builder run, start to end. Outside the sandbox it lays out the run's
 * scratch directory (the starter app pinned to the round's tarballs, a fake
 * Firebase config, the brief, pyric's docs) and starts the model channel's
 * forwarder, which alone holds the harness's token. Everything that runs
 * code from the app or the builder runs inside the run's own sandbox: the
 * install, the export of the installed package's conformance pages, and the
 * run phase (`run-phase.ts`), which starts the builder. Afterward
 * `run-finish.ts` merges the records, scans for the token, keeps the run's
 * data and appends its measurement line.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareApp, runTimedCommand, type Tarballs } from '../apps/install.ts';
import { installApp, npmCacheDir } from './app-install.ts';
import { renderBrief, type Brief } from './brief.ts';
import { playwrightBrowsersPath } from './browser-server.ts';
import type { Builder } from './builder-command.ts';
import { readChannelRecord, type Listening } from './model-channel.ts';
import { startModelForwarder } from './model-forwarder.ts';
import type { RunMeter } from './model-meter.ts';
import { startEgressNamespace, type EgressNamespace } from './namespace.ts';
import type { Provenance } from './provenance.ts';
import { builderRunDirsAt, builderRunRoot, channelRecordFile, measurementsFile, runDataDir, type BuilderRunDirs } from './round-paths.ts';
import { finishRun } from './run-finish.ts';
import { BUILDER_LOG, type Phase } from './run-phase.ts';
import type { RunIdentity, RunRecord } from './run-record.ts';
import { createRunDirs, demoProjectId, writeFakeFirebaseConfig } from './scratch.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STARTERS = fileURLToPath(new URL('./starters', import.meta.url));
const RUN_PHASE = fileURLToPath(new URL('./run-phase.ts', import.meta.url));
const DOCS_EXPORT = fileURLToPath(new URL('./docs-export.mjs', import.meta.url));
const SITE_DOCS = join(REPO_ROOT, 'packages', 'site-docs', 'src', 'content');
/** Time the run phase gets beyond the builder's own cap, to start the browser and stop everything. */
const PHASE_MARGIN_MS = 300_000;
const DOCS_EXPORT_TIMEOUT_MS = 60_000;

export interface BuilderRunInput {
  identity: RunIdentity;
  brief: Brief;
  builder: Builder;
  tarballs: Tarballs;
  /** The tarballs' directory, bound read-only into the sandbox. */
  packagesDir: string;
  provenance: Provenance;
  /** The run's share of the round's meter, which the forwarder checks before each request. */
  meter: RunMeter;
  /**
   * The harness's token (`harness-token.ts`), read outside the sandbox. Only
   * the forwarder, for a builder that uses the model, and the token scan get
   * it; no record, log or environment does.
   */
  token: string | undefined;
  /**
   * Every token value the harness holds, the token's and, when a token file
   * won over it, the environment's: the token scan looks for and redacts each.
   */
  scanned: readonly string[];
  say: (line: string) => void;
}

/**
 * Whether a run has started before: its sandbox started, or its data is kept.
 * A round never redoes a run. A run whose sandbox never started leaves only
 * empty directories, which a later round reuses.
 */
export function runExists(round: string, run: string): boolean {
  return existsSync(builderRunDirsAt(builderRunRoot(round, run)).started) || existsSync(runDataDir(round, run));
}

function layOut(input: BuilderRunInput, dirs: BuilderRunDirs): void {
  const { identity, brief } = input;
  writeFileSync(dirs.briefText, renderBrief(brief, { model: identity.model, maxBudgetUsd: identity.maxBudgetUsd }));
  writeFileSync(dirs.briefJson, `${JSON.stringify(brief, null, 2)}\n`);
  prepareApp({ appDir: join(STARTERS, brief.framework), projectDir: dirs.app, tarballs: input.tarballs });
  writeFakeFirebaseConfig(dirs.app, demoProjectId(identity.run));
  cpSync(SITE_DOCS, join(dirs.docs, 'site'), { recursive: true });
}

async function exportConformanceDocs(namespace: EgressNamespace, dirs: BuilderRunDirs): Promise<void> {
  const { command, args } = namespace.enter('node', [DOCS_EXPORT, dirs.app, join(dirs.docs, 'conformance')], dirs.app);
  const result = await runTimedCommand(command, args, { cwd: REPO_ROOT, env: { PATH: process.env.PATH, HOME: dirs.home }, timeoutMs: DOCS_EXPORT_TIMEOUT_MS });
  writeFileSync(join(dirs.logs, '01-docs-export.log'), result.output);
  if (result.code !== 0) throw new Error(`exporting the conformance pages failed (exit ${result.code}):\n${result.output}`);
}

/**
 * The run phase's environment, built from nothing: PATH, the run's HOME,
 * where Playwright's browsers are (read from the harness's own HOME, since
 * the run's has none), LANG and TMPDIR. Nothing else of the harness's
 * environment, and so not its token, enters the sandbox.
 */
export function phaseEnvironment(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const phase: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: home, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath() };
  for (const name of ['LANG', 'TMPDIR']) {
    if (env[name] !== undefined) phase[name] = env[name];
  }
  return phase;
}

/** Runs the phase; resolves its output, which the caller writes once the sandbox has stopped. */
async function runPhase(namespace: EgressNamespace, input: BuilderRunInput, dirs: BuilderRunDirs): Promise<string> {
  const invocation = input.builder.invocation({
    briefText: dirs.briefText,
    briefJson: dirs.briefJson,
    docsDir: dirs.docs,
    reportFile: dirs.report,
    model: input.identity.model,
    maxBudgetUsd: input.identity.maxBudgetUsd,
  });
  const wallClockMs = input.brief.limits.wallClockMinutes * 60_000;
  const phase: Phase = { ...invocation, wallClockMs, modelChannel: true, log: BUILDER_LOG };
  writeFileSync(dirs.phase, `${JSON.stringify(phase, null, 2)}\n`);
  const { command, args } = namespace.enter(process.execPath, [RUN_PHASE, dirs.root], REPO_ROOT);
  const result = await runTimedCommand(command, args, { cwd: REPO_ROOT, env: phaseEnvironment(dirs.home), timeoutMs: wallClockMs + PHASE_MARGIN_MS });
  input.say(`run phase exited ${result.code}${result.timedOut ? ' (stopped at its limit)' : ''}`);
  return result.output;
}

/** Runs the builder in a sandbox that has started, with the forwarder outside it; stops both. */
async function runInSandbox(namespace: EgressNamespace, input: BuilderRunInput, dirs: BuilderRunDirs, channelRecord: string): Promise<string> {
  let forwarder: Listening | undefined;
  try {
    writeFileSync(dirs.started, `${new Date().toISOString()}\n`);
    layOut(input, dirs);
    writeFileSync(channelRecord, '');
    const credential = input.builder.usesModel ? input.token : undefined;
    forwarder = await startModelForwarder({ socketPath: dirs.modelSocket, record: channelRecord, credential, meter: input.meter });
    await installApp(namespace, dirs, input.identity.run, input.say);
    await exportConformanceDocs(namespace, dirs);
    return await runPhase(namespace, input, dirs);
  } finally {
    await forwarder?.close();
    await namespace.stop();
  }
}

/**
 * Runs one builder and keeps its data. Resolves the run's record. Throws
 * `NamespaceUnavailable`, before the run counts as started, when its sandbox
 * can't start.
 */
export async function runBuilder(input: BuilderRunInput): Promise<RunRecord> {
  const { identity } = input;
  const dirs = builderRunDirsAt(builderRunRoot(identity.round, identity.run));
  const channelRecord = channelRecordFile(identity.round, identity.run);
  createRunDirs(dirs.root);
  mkdirSync(dirs.docs, { recursive: true });
  const startedAt = new Date();
  input.say(`${identity.run}: starting its sandbox in ${dirs.root}`);
  const readOnly = [playwrightBrowsersPath(), input.packagesDir, ...input.builder.readOnly];
  const namespace = await startEgressNamespace({ networkLog: dirs.networkLog, runRoot: dirs.root, readOnly, overlaid: [npmCacheDir()] });
  const phaseOutput = await runInSandbox(namespace, input, dirs, channelRecord);
  const end = { dirs, channel: readChannelRecord(channelRecord), phaseOutput, startedAt, dataDir: runDataDir(identity.round, identity.run), measurements: measurementsFile() };
  return finishRun(input, end);
}
