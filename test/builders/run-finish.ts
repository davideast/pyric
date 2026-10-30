/**
 * The end of one builder run, once nothing in its sandbox can write the run
 * root: append the run's measurement line, merge the forwarder's record and
 * the browser's NetLog into the run's network record, build the run's
 * record, look for the token in everything it keeps and keep the run's data.
 *
 * The measurement line comes first, from the harness's own state alone (the
 * run's identity, the forwarder's record and the harness's timing of the
 * run phase), so nothing the builder left in the run root can lose the
 * run's spend. Then the harness gives the owner back its permissions across
 * the run root (`owner-access.ts`), since the sandbox's uid 0 is the
 * harness's own uid. A merge, a write or a read that still fails skips its
 * file, like a planted one, and the record says why. Lines of
 * `network.jsonl` without an event's shape are left out and counted, and a
 * record that can't be built is built again without the network record;
 * either names `network.jsonl` in the record, which makes the run invalid.
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
import { appendBrowserEvents, readNetworkLines, type NetworkEvent } from './recorder/network-record.ts';
import { readBuilderReport, type ReadReport } from './report.ts';
import type { BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, type PhaseResult } from './run-phase.ts';
import { measurementLine, runRecord, type RunIdentity, type RunOutcome, type RunRecord } from './run-record.ts';
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
  /** How long the run phase took, by the harness's own clock. */
  wallMs: number;
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

/** Files the harness skips or leaves out, by path, with why. */
type SkippedFiles = Map<string, string>;

/** What the harness found wrong in the run root, once the sandbox stopped. */
interface RunRootFindings {
  /** Files the harness skips in the reads, the token scan and the copies. */
  skipped: SkippedFiles;
  /** Files the harness still keeps, but read only in part. */
  leftOut: SkippedFiles;
}

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

/** `read()`, or `fallback` when `path` is skipped, or is unreadable or its read throws, either of which skips it. */
function readOr<T>(skipped: SkippedFiles, path: string, fallback: T, read: () => T): T {
  if (skipped.has(path)) return fallback;
  if (!canRead(path)) {
    skipped.set(path, `${path} is unreadable`);
    return fallback;
  }
  try {
    return read();
  } catch (error) {
    skipped.set(path, `the read failed: ${firstLine(error)}`);
    return fallback;
  }
}

function unreadReport(dirs: BuilderRunDirs, planted: Skipped): ReadReport {
  const why = planted.has(dirs.report) ? 'is a planted link' : 'could not be read';
  return { state: 'invalid', report: null, errors: [`${relative(dirs.root, dirs.report)} ${why}; the harness did not read it`] };
}

const rejectedLines = (count: number) => (count === 1 ? '1 line is not a network event; the harness left it out' : `${count} lines are not network events; the harness left them out`);

function readRunFiles(dirs: BuilderRunDirs, planted: Skipped, findings: RunRootFindings): RunFiles {
  const { skipped, leftOut } = findings;
  const builderLog = join(dirs.logs, BUILDER_LOG);
  const network = readOr(skipped, dirs.networkLog, { events: [], rejected: 0 }, () => readNetworkLines(dirs.networkLog));
  if (network.rejected > 0) leftOut.set(dirs.networkLog, rejectedLines(network.rejected));
  const report = readOr<ReadReport | null>(skipped, dirs.report, null, () => readBuilderReport(dirs.report));
  return {
    exit: readOr(skipped, dirs.phaseResult, null, () => readPhaseResult(dirs)),
    report: report ?? unreadReport(dirs, planted),
    record: network.events,
    usage: readOr(skipped, builderLog, null, () => usageFrom(readIfExists(builderLog))),
  };
}

const skippedNotice = (run: string, entries: readonly string[]) => `${run}: the harness skipped ${entries.join('; ')}, and the run is invalid`;

/** Runs `step`; when it throws, skips `path` and records why. */
function attempt(skipped: SkippedFiles, path: string, what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    skipped.set(path, `${what} failed: ${firstLine(error)}`);
  }
}

/** The merges and the phase log's write, for a run root with no planted link. */
function settleRunRoot(end: RunEnd, skipped: SkippedFiles): void {
  const { dirs, channel } = end;
  attempt(skipped, dirs.networkLog, 'the merge', () => mergeRecords(dirs, channel));
  attempt(skipped, join(dirs.logs, RUN_PHASE_LOG), 'the write', () => writeFileSync(join(dirs.logs, RUN_PHASE_LOG), end.phaseOutput));
}

/** Each skipped or left-out file as `<path>: <why>`, relative to the run root. */
function skippedEntries(root: string, findings: RunRootFindings): string[] {
  const inRoot = (text: string) => text.split(`${root}/`).join('');
  const all = new Map([...findings.leftOut, ...findings.skipped]);
  return [...all].map(([path, why]) => `${relative(root, path)}: ${inRoot(why)}`).sort();
}

/**
 * The run's record. When it can't be built, it is built again without the
 * network record, and names `network.jsonl` with why.
 */
function buildRecord(outcome: Omit<RunOutcome, 'plantedLinks'>, dirs: BuilderRunDirs, findings: RunRootFindings): RunRecord {
  try {
    return runRecord({ ...outcome, plantedLinks: skippedEntries(dirs.root, findings) });
  } catch (error) {
    findings.leftOut.set(dirs.networkLog, `building the run record failed: ${firstLine(error)}`);
    return runRecord({ ...outcome, record: [], plantedLinks: skippedEntries(dirs.root, findings) });
  }
}

/** The kept files that hold the token: the run root's, and a planted run's phase output, which is kept apart. */
function tokenFound(input: FinishInput, end: RunEnd, skip: Skipped, isKeptApart: boolean): string[] {
  const found = tokenFoundIn(end.dirs, input.scanned, skip);
  const outputHoldsToken = input.scanned.some((secret) => end.phaseOutput.includes(secret));
  return isKeptApart && outputHoldsToken ? [...found, KEPT_PHASE_OUTPUT].sort() : found;
}

/** Ends a run whose sandbox has stopped: measures, merges, scans and keeps it. Resolves its record. */
export async function finishRun(input: FinishInput, end: RunEnd): Promise<RunRecord> {
  const { dirs, channel } = end;
  appendMeasurement(end.measurements, measurementLine(input.identity, channel, end.wallMs));
  restoreOwnerAccess(dirs.root, new Set([join(dirs.app, 'node_modules')]));
  const findings: RunRootFindings = { skipped: new Map(plantedLinks(dirs.root, harnessTouchedPaths(dirs)).map((link) => [link.path, link.problem])), leftOut: new Map() };
  const planted: Skipped = new Set(findings.skipped.keys());
  const hasPlantedLinks = planted.size > 0;
  if (!hasPlantedLinks) settleRunRoot(end, findings.skipped);
  const isPhaseOutputApart = hasPlantedLinks || findings.skipped.has(join(dirs.logs, RUN_PHASE_LOG));
  const files = readRunFiles(dirs, planted, findings);
  const outcome = { identity: input.identity, brief: input.brief, provenance: input.provenance, startedAt: end.startedAt, endedAt: new Date(), ...files, channel, tokenFoundIn: [] };
  const measured = buildRecord(outcome, dirs, findings);
  const entries = measured.harness.plantedLinks;
  if (entries.length > 0) input.say(skippedNotice(input.identity.run, entries));
  const skip: Skipped = new Set(findings.skipped.keys());
  const found = tokenFound(input, end, skip, isPhaseOutputApart);
  if (found.length > 0) input.say(tokenNotice(input.identity.run, found));
  const record: RunRecord = { ...measured, harness: { ...measured.harness, tokenFoundIn: found } };
  await keep(record, dirs, end.dataDir, input.scanned, skip);
  if (isPhaseOutputApart) writeFileSync(join(end.dataDir, KEPT_PHASE_OUTPUT), redactedText(end.phaseOutput, input.scanned));
  return record;
}
