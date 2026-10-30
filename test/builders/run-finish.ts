/**
 * The end of one builder run, once nothing in its sandbox can write the run
 * root: merge the forwarder's record and the browser's NetLog into the run's
 * network record, look for the token in everything it keeps, build the run's
 * record, keep the run's data and append its measurement line.
 *
 * First it gives the owner back its permissions across the run root
 * (`owner-access.ts`), since the sandbox's uid 0 is the harness's own uid.
 * The measurement line is appended as soon as the record is built, before
 * the token scan and the keep, so a later failure can't lose the run's
 * spend. A merge or a write that still fails skips its file, like a
 * planted one, and the record says why.
 *
 * When the sandbox left a link on a file the harness would touch
 * (`planted-links.ts`), the harness skips the merges and every such file in
 * the reads, the scan and the keep, but still keeps the record, naming the
 * planted paths, and the phase's output, under a name nothing in the run
 * root is copied to.
 */
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runCommand } from '../apps/install.ts';
import type { Brief } from './brief.ts';
import { appendMeasurement } from './measurement.ts';
import type { ModelChannelEvent } from './model-channel.ts';
import { parseJsonText } from './parse.ts';
import { restoreOwnerAccess } from './owner-access.ts';
import { assertNoPlantedLinks, plantedLinks } from './planted-links.ts';
import type { Provenance } from './provenance.ts';
import { browserEvents, readNetLog } from './recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord, type NetworkEvent } from './recorder/network-record.ts';
import { readBuilderReport, type ReadReport } from './report.ts';
import type { BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, type PhaseResult } from './run-phase.ts';
import { measurementLine, runRecord, type RunIdentity, type RunRecord } from './run-record.ts';
import { copyRedacted, filesContaining, redactedText, type Secrets, type Skipped } from './token-scan.ts';
import { usageFrom, type Usage } from './usage.ts';

export const RUN_PHASE_LOG = '02-run-phase.log';

/**
 * Where a planted run's phase output is kept, at the top of the run's data,
 * beside `report.json`: no file of the run root is copied there.
 */
export const KEPT_PHASE_OUTPUT = 'phase-output.log';

/** How the phase said its command ended; null when it never wrote that, or wrote something else. */
export function readPhaseResult(dirs: BuilderRunDirs): PhaseResult | null {
  if (!existsSync(dirs.phaseResult)) return null;
  const json = parseJsonText(readFileSync(dirs.phaseResult, 'utf8'));
  const parsed = json.ok ? phaseResultSchema.safeParse(json.value) : undefined;
  return parsed?.success === true ? parsed.data : null;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** What `keep` copies of the scratch directory. */
const keptPaths = (dirs: BuilderRunDirs) => [dirs.report, dirs.briefJson, dirs.networkLog, dirs.logs, dirs.app];

/** The kept files, relative to the run root, that hold any of `secrets`. Names files, never a value. */
export function tokenFoundIn(dirs: BuilderRunDirs, secrets: readonly string[], skip?: Skipped): string[] {
  const found = new Set(secrets.flatMap((secret) => keptPaths(dirs).flatMap((path) => filesContaining(path, secret, skip))));
  return [...found].map((path) => relative(dirs.root, path)).sort();
}

const isInApp = (path: string) => path === 'app' || path.startsWith('app/');

/**
 * Copies what the harness keeps of the run into the data root, with the
 * token's value replaced wherever it turns up. The app is packed without
 * node_modules, and withheld when any file of it held the token. Nothing in
 * `skip` is copied.
 */
export async function keep(record: RunRecord, dirs: BuilderRunDirs, dataDir: string, token: Secrets, skip?: Skipped): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'report.json'), redactedText(`${JSON.stringify(record, null, 2)}\n`, token));
  copyRedacted(dirs.briefJson, join(dataDir, 'brief.json'), token, skip);
  copyRedacted(dirs.networkLog, join(dataDir, 'network.jsonl'), token, skip);
  copyRedacted(dirs.logs, join(dataDir, 'logs'), token, skip);
  if (record.harness.tokenFoundIn.some(isInApp)) return;
  const tar = await runCommand('tar', ['-czf', join(dataDir, 'app.tgz'), '--exclude=node_modules', '-C', dirs.root, 'app'], { cwd: dirs.root });
  if (tar.code !== 0) throw new Error(`packing the app failed (exit ${tar.code}):\n${tar.output}`);
}

/** Every file of the run root the harness reads or appends to once the sandbox has stopped. */
export const harnessTouchedPaths = (dirs: BuilderRunDirs) => [
  dirs.networkLog, dirs.netLog, dirs.report, dirs.phaseResult, join(dirs.logs, BUILDER_LOG), join(dirs.logs, RUN_PHASE_LOG),
];

/**
 * Once nothing in the sandbox can write the run root: refuses a planted link
 * on any file the harness touches, then appends the forwarder's lines and the
 * browser's NetLog to the run's network record.
 */
export function mergeRecords(dirs: BuilderRunDirs, channel: readonly ModelChannelEvent[]): void {
  assertNoPlantedLinks(dirs.root, harnessTouchedPaths(dirs));
  if (channel.length > 0) appendFileSync(dirs.networkLog, channel.map((event) => `${JSON.stringify(event)}\n`).join(''));
  if (existsSync(dirs.netLog)) appendBrowserEvents(dirs.networkLog, browserEvents(readNetLog(readFileSync(dirs.netLog, 'utf8'))));
}

function tokenNotice(run: string, found: readonly string[]): string {
  const withheld = found.some(isInApp) ? ' and the app is withheld' : '';
  return `${run}: the harness's token turned up in ${found.join(', ')}; the kept copies are redacted${withheld}`;
}

/** What the end of a run needs of the run's input. */
export interface FinishInput {
  identity: RunIdentity;
  brief: Brief;
  provenance: Provenance;
  /** Every token value the token scan looks for and redacts. */
  scanned: readonly string[];
  say: (line: string) => void;
}

/** What the run left, and where its data goes. */
export interface RunEnd {
  dirs: BuilderRunDirs;
  /** The forwarder's own record of the run, read from outside the run root. */
  channel: readonly ModelChannelEvent[];
  phaseOutput: string;
  startedAt: Date;
  dataDir: string;
  measurements: string;
}

/** What the record reads of the run root: each file, unless it is planted or unreadable. */
interface RunFiles {
  exit: PhaseResult | null;
  report: ReadReport;
  record: NetworkEvent[];
  usage: Usage | null;
}

/** Whether the harness can read `path`: absent, or readable by it. */
function canRead(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readRunFiles(dirs: BuilderRunDirs, planted: Skipped): RunFiles {
  const isReadable = (path: string) => !planted.has(path) && canRead(path);
  const builderLog = join(dirs.logs, BUILDER_LOG);
  const why = planted.has(dirs.report) ? 'is a planted link' : 'is unreadable';
  const unreadReport: ReadReport = { state: 'invalid', report: null, errors: [`${relative(dirs.root, dirs.report)} ${why}; the harness did not read it`] };
  return {
    exit: isReadable(dirs.phaseResult) ? readPhaseResult(dirs) : null,
    report: isReadable(dirs.report) ? readBuilderReport(dirs.report) : unreadReport,
    record: isReadable(dirs.networkLog) ? readNetworkRecord(dirs.networkLog) : [],
    usage: isReadable(builderLog) ? usageFrom(readIfExists(builderLog)) : null,
  };
}

const skippedNotice = (run: string, entries: readonly string[]) => `${run}: the harness skipped ${entries.join('; ')}, and the run is invalid`;

/** Files the harness skips, by path, with why. */
type SkippedFiles = Map<string, string>;

/** Runs `step`; when it throws, skips `path` and records why. */
function attempt(skipped: SkippedFiles, path: string, what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
    skipped.set(path, `${what} failed: ${message}`);
  }
}

/** The merges and the phase log's write, for a run root with no planted link. */
function settleRunRoot(end: RunEnd, skipped: SkippedFiles): void {
  const { dirs, channel } = end;
  attempt(skipped, dirs.networkLog, 'the merge', () => mergeRecords(dirs, channel));
  attempt(skipped, join(dirs.logs, RUN_PHASE_LOG), 'the write', () => writeFileSync(join(dirs.logs, RUN_PHASE_LOG), end.phaseOutput));
}

/** Each skipped file as `<path>: <why>`, relative to the run root. */
function skippedEntries(root: string, skipped: SkippedFiles): string[] {
  const inRoot = (text: string) => text.split(`${root}/`).join('');
  return [...skipped].map(([path, why]) => `${relative(root, path)}: ${inRoot(why)}`).sort();
}

/** The kept files that hold the token: the run root's, and a planted run's phase output, which is kept apart. */
function tokenFound(input: FinishInput, end: RunEnd, planted: Skipped): string[] {
  const found = tokenFoundIn(end.dirs, input.scanned, planted);
  const isKeptApart = planted.size > 0;
  const outputHoldsToken = input.scanned.some((secret) => end.phaseOutput.includes(secret));
  return isKeptApart && outputHoldsToken ? [...found, KEPT_PHASE_OUTPUT].sort() : found;
}

/** Ends a run whose sandbox has stopped: merges, measures, scans and keeps it. Resolves its record. */
export async function finishRun(input: FinishInput, end: RunEnd): Promise<RunRecord> {
  const { dirs, channel } = end;
  restoreOwnerAccess(dirs.root, new Set([join(dirs.app, 'node_modules')]));
  const skipped: SkippedFiles = new Map(plantedLinks(dirs.root, harnessTouchedPaths(dirs)).map((link) => [link.path, link.problem]));
  const hasPlantedLinks = skipped.size > 0;
  if (!hasPlantedLinks) settleRunRoot(end, skipped);
  const isPhaseOutputApart = hasPlantedLinks || skipped.has(join(dirs.logs, RUN_PHASE_LOG));
  const entries = skippedEntries(dirs.root, skipped);
  if (entries.length > 0) input.say(skippedNotice(input.identity.run, entries));
  const planted: Skipped = new Set(skipped.keys());
  const measured = runRecord({
    identity: input.identity,
    brief: input.brief,
    provenance: input.provenance,
    startedAt: end.startedAt,
    endedAt: new Date(),
    ...readRunFiles(dirs, planted),
    channel,
    tokenFoundIn: [],
    plantedLinks: entries,
  });
  appendMeasurement(end.measurements, measurementLine(measured));
  const found = tokenFound(input, end, planted);
  if (found.length > 0) input.say(tokenNotice(input.identity.run, found));
  const record: RunRecord = { ...measured, harness: { ...measured.harness, tokenFoundIn: found } };
  await keep(record, dirs, end.dataDir, input.scanned, planted);
  if (isPhaseOutputApart) writeFileSync(join(end.dataDir, KEPT_PHASE_OUTPUT), redactedText(end.phaseOutput, input.scanned));
  return record;
}
