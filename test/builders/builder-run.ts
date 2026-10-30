/**
 * One builder run, start to end. Outside the sandbox it lays out the run's
 * scratch directory (the starter app pinned to the round's tarballs, a fake
 * Firebase config, the brief, pyric's docs) and starts the model channel's
 * forwarder. Everything that runs code from the app or the builder runs
 * inside the run's own sandbox: the install, the export of the installed
 * package's conformance pages, and the run phase (`run-phase.ts`), which
 * starts the builder. Afterward it keeps the run's data and appends its
 * measurement line.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareApp, runCommand, runTimedCommand, type Tarballs } from '../apps/install.ts';
import { installApp, npmCacheDir } from './app-install.ts';
import { renderBrief, type Brief } from './brief.ts';
import { playwrightBrowsersPath } from './browser-server.ts';
import type { Builder } from './builder-command.ts';
import { appendMeasurement } from './measurement.ts';
import { MODEL_API, startModelForwarder } from './model-channel.ts';
import { startEgressNamespace, type EgressNamespace } from './namespace.ts';
import type { Provenance } from './provenance.ts';
import { browserEvents, readNetLog } from './recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from './recorder/network-record.ts';
import { readBuilderReport } from './report.ts';
import { builderRunDirsAt, builderRunRoot, measurementsFile, runDataDir, type BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, type Phase, type PhaseResult } from './run-phase.ts';
import { measurementLine, runRecord, type RunIdentity, type RunRecord } from './run-record.ts';
import { createRunDirs, demoProjectId, writeFakeFirebaseConfig } from './scratch.ts';
import { usageFrom } from './usage.ts';

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
  say: (line: string) => void;
}

/** Whether a run already has scratch or data on disk: a round never overwrites a run. */
export function runExists(round: string, run: string): boolean {
  return existsSync(builderRunRoot(round, run)) || existsSync(runDataDir(round, run));
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
 * The run phase's environment: PATH, the run's HOME, where Playwright's
 * browsers are (read from the harness's own HOME, since the run's has none),
 * and only the variables the builder takes from the harness.
 */
function phaseEnvironment(home: string, passEnv: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath() };
  for (const name of [...passEnv, 'LANG', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function runPhase(namespace: EgressNamespace, input: BuilderRunInput, dirs: BuilderRunDirs): Promise<void> {
  const invocation = input.builder.invocation({
    briefText: dirs.briefText,
    briefJson: dirs.briefJson,
    docsDir: dirs.docs,
    reportFile: dirs.report,
    model: input.identity.model,
    maxBudgetUsd: input.identity.maxBudgetUsd,
  });
  const wallClockMs = input.brief.limits.wallClockMinutes * 60_000;
  const phase: Phase = { ...invocation, wallClockMs };
  writeFileSync(dirs.phase, `${JSON.stringify(phase, null, 2)}\n`);
  const { command, args } = namespace.enter(process.execPath, [RUN_PHASE, dirs.root], REPO_ROOT);
  const result = await runTimedCommand(command, args, { cwd: REPO_ROOT, env: phaseEnvironment(dirs.home, invocation.passEnv), timeoutMs: wallClockMs + PHASE_MARGIN_MS });
  writeFileSync(join(dirs.logs, '02-run-phase.log'), result.output);
  input.say(`run phase exited ${result.code}${result.timedOut ? ' (stopped at its limit)' : ''}`);
}

function readPhaseResult(dirs: BuilderRunDirs): PhaseResult | null {
  if (!existsSync(dirs.phaseResult)) return null;
  const parsed = phaseResultSchema.safeParse(JSON.parse(readFileSync(dirs.phaseResult, 'utf8')));
  return parsed.success ? parsed.data : null;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** Copies what the harness keeps of the run into the data root, with the app packed without node_modules. */
async function keep(record: RunRecord, dirs: BuilderRunDirs, dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'report.json'), `${JSON.stringify(record, null, 2)}\n`);
  cpSync(dirs.briefJson, join(dataDir, 'brief.json'));
  cpSync(dirs.networkLog, join(dataDir, 'network.jsonl'));
  cpSync(dirs.logs, join(dataDir, 'logs'), { recursive: true });
  const tar = await runCommand('tar', ['-czf', join(dataDir, 'app.tgz'), '--exclude=node_modules', '-C', dirs.root, 'app'], { cwd: dirs.root });
  if (tar.code !== 0) throw new Error(`packing the app failed (exit ${tar.code}):\n${tar.output}`);
}

/** Runs one builder and keeps its data. Resolves the run's record. */
export async function runBuilder(input: BuilderRunInput): Promise<RunRecord> {
  const { identity } = input;
  const dirs = builderRunDirsAt(builderRunRoot(identity.round, identity.run));
  createRunDirs(dirs.root);
  mkdirSync(dirs.docs, { recursive: true });
  const startedAt = new Date();
  layOut(input, dirs);
  input.say(`${identity.run}: starting its sandbox in ${dirs.root}`);
  const readOnly = [playwrightBrowsersPath(), input.packagesDir, ...input.builder.readOnly];
  const namespace = await startEgressNamespace({ networkLog: dirs.networkLog, runRoot: dirs.root, readOnly, overlaid: [npmCacheDir()] });
  const forwarder = await startModelForwarder({ socketPath: dirs.modelSocket, networkLog: dirs.networkLog, allowed: MODEL_API });
  try {
    await installApp(namespace, dirs, identity.run, input.say);
    await exportConformanceDocs(namespace, dirs);
    await runPhase(namespace, input, dirs);
  } finally {
    await forwarder.close();
    await namespace.stop();
  }
  if (existsSync(dirs.netLog)) appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
  const record = runRecord({
    identity,
    brief: input.brief,
    provenance: input.provenance,
    startedAt,
    endedAt: new Date(),
    exit: readPhaseResult(dirs),
    report: readBuilderReport(dirs.report),
    record: readNetworkRecord(dirs.networkLog),
    usage: usageFrom(readIfExists(join(dirs.logs, BUILDER_LOG))),
  });
  await keep(record, dirs, runDataDir(identity.round, identity.run));
  appendMeasurement(measurementsFile(), measurementLine(record));
  return record;
}
