/**
 * One builder run, start to end. Outside the sandbox it lays out the run's
 * scratch directory (the starter app pinned to the round's tarballs, a fake
 * Firebase config, the brief, pyric's docs) and starts the model channel's
 * forwarder, which alone holds the harness's token. Everything that runs
 * code from the app or the builder runs inside the run's own sandbox: the
 * install, the export of the installed package's conformance pages, and the
 * run phase (`run-phase.ts`), which starts the builder. Afterward it merges
 * the forwarder's record into the run's network record, looks for the token
 * in everything it keeps, keeps the run's data and appends its measurement
 * line.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareApp, runCommand, runTimedCommand, type Tarballs } from '../apps/install.ts';
import { installApp, npmCacheDir } from './app-install.ts';
import { renderBrief, type Brief } from './brief.ts';
import { playwrightBrowsersPath } from './browser-server.ts';
import { OAUTH_TOKEN_ENV, type Builder } from './builder-command.ts';
import { appendMeasurement } from './measurement.ts';
import { readChannelRecord, type Listening, type ModelChannelEvent } from './model-channel.ts';
import { startModelForwarder } from './model-forwarder.ts';
import type { RunMeter } from './model-meter.ts';
import { startEgressNamespace, type EgressNamespace } from './namespace.ts';
import type { Provenance } from './provenance.ts';
import { browserEvents, readNetLog } from './recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from './recorder/network-record.ts';
import { readBuilderReport } from './report.ts';
import { builderRunDirsAt, builderRunRoot, channelRecordFile, measurementsFile, runDataDir, type BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, type Phase, type PhaseResult } from './run-phase.ts';
import { measurementLine, runRecord, type RunIdentity, type RunRecord } from './run-record.ts';
import { createRunDirs, demoProjectId, writeFakeFirebaseConfig } from './scratch.ts';
import { copyRedacted, filesContaining, redactedText } from './token-scan.ts';
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
  /** The run's share of the round's meter, which the forwarder checks before each request. */
  meter: RunMeter;
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

/** The harness's token, from its own environment; undefined when it has none. */
function harnessToken(): string | undefined {
  const token = process.env[OAUTH_TOKEN_ENV];
  const isSet = token !== undefined && token !== '';
  return isSet ? token : undefined;
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
  const phase: Phase = { ...invocation, wallClockMs, modelChannel: true, log: BUILDER_LOG };
  writeFileSync(dirs.phase, `${JSON.stringify(phase, null, 2)}\n`);
  const { command, args } = namespace.enter(process.execPath, [RUN_PHASE, dirs.root], REPO_ROOT);
  const result = await runTimedCommand(command, args, { cwd: REPO_ROOT, env: phaseEnvironment(dirs.home), timeoutMs: wallClockMs + PHASE_MARGIN_MS });
  writeFileSync(join(dirs.logs, '02-run-phase.log'), result.output);
  input.say(`run phase exited ${result.code}${result.timedOut ? ' (stopped at its limit)' : ''}`);
}

/** How the phase said its command ended; null when it never wrote that, or wrote something else. */
export function readPhaseResult(dirs: BuilderRunDirs): PhaseResult | null {
  if (!existsSync(dirs.phaseResult)) return null;
  const parsed = phaseResultSchema.safeParse(JSON.parse(readFileSync(dirs.phaseResult, 'utf8')));
  return parsed.success ? parsed.data : null;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** What `keep` copies of the scratch directory. */
const keptPaths = (dirs: BuilderRunDirs) => [dirs.report, dirs.briefJson, dirs.networkLog, dirs.logs, dirs.app];

/** The kept files, relative to the run root, that hold `token`. Names files, never the value. */
export function tokenFoundIn(dirs: BuilderRunDirs, token: string | undefined): string[] {
  if (token === undefined) return [];
  return keptPaths(dirs).flatMap((path) => filesContaining(path, token)).map((path) => relative(dirs.root, path)).sort();
}

const isInApp = (path: string) => path === 'app' || path.startsWith('app/');

/**
 * Copies what the harness keeps of the run into the data root, with the
 * token's value replaced wherever it turns up. The app is packed without
 * node_modules, and withheld when any file of it held the token.
 */
async function keep(record: RunRecord, dirs: BuilderRunDirs, dataDir: string, token: string | undefined): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'report.json'), redactedText(`${JSON.stringify(record, null, 2)}\n`, token));
  copyRedacted(dirs.briefJson, join(dataDir, 'brief.json'), token);
  copyRedacted(dirs.networkLog, join(dataDir, 'network.jsonl'), token);
  copyRedacted(dirs.logs, join(dataDir, 'logs'), token);
  if (record.harness.tokenFoundIn.some(isInApp)) return;
  const tar = await runCommand('tar', ['-czf', join(dataDir, 'app.tgz'), '--exclude=node_modules', '-C', dirs.root, 'app'], { cwd: dirs.root });
  if (tar.code !== 0) throw new Error(`packing the app failed (exit ${tar.code}):\n${tar.output}`);
}

/** Appends the forwarder's lines to the run's network record, once nothing in the sandbox can write it. */
function mergeChannelRecord(networkLog: string, channel: readonly ModelChannelEvent[]): void {
  if (channel.length > 0) appendFileSync(networkLog, channel.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

/** Runs the builder in a sandbox that has started, with the forwarder outside it; stops both. */
async function runInSandbox(namespace: EgressNamespace, input: BuilderRunInput, dirs: BuilderRunDirs, channelRecord: string): Promise<void> {
  let forwarder: Listening | undefined;
  try {
    writeFileSync(dirs.started, `${new Date().toISOString()}\n`);
    layOut(input, dirs);
    writeFileSync(channelRecord, '');
    const credential = input.builder.usesModel ? harnessToken() : undefined;
    forwarder = await startModelForwarder({ socketPath: dirs.modelSocket, record: channelRecord, credential, meter: input.meter });
    await installApp(namespace, dirs, input.identity.run, input.say);
    await exportConformanceDocs(namespace, dirs);
    await runPhase(namespace, input, dirs);
  } finally {
    await forwarder?.close();
    await namespace.stop();
  }
}

function tokenNotice(run: string, found: readonly string[]): string {
  const withheld = found.some(isInApp) ? ' and the app is withheld' : '';
  return `${run}: the harness's token turned up in ${found.join(', ')}; the kept copies are redacted${withheld}`;
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
  await runInSandbox(namespace, input, dirs, channelRecord);
  const channel = readChannelRecord(channelRecord);
  mergeChannelRecord(dirs.networkLog, channel);
  if (existsSync(dirs.netLog)) appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
  const token = harnessToken();
  const found = tokenFoundIn(dirs, token);
  if (found.length > 0) input.say(tokenNotice(identity.run, found));
  const record = runRecord({
    identity,
    brief: input.brief,
    provenance: input.provenance,
    startedAt,
    endedAt: new Date(),
    exit: readPhaseResult(dirs),
    report: readBuilderReport(dirs.report),
    record: readNetworkRecord(dirs.networkLog),
    channel,
    usage: usageFrom(readIfExists(join(dirs.logs, BUILDER_LOG))),
    tokenFoundIn: found,
  });
  await keep(record, dirs, runDataDir(identity.round, identity.run), token);
  appendMeasurement(measurementsFile(), measurementLine(record));
  return record;
}
