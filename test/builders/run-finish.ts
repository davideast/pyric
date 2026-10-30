/**
 * The end of one builder run, once nothing in its sandbox can write the run
 * root: merge the forwarder's record and the browser's NetLog into the run's
 * network record, look for the token in everything it keeps, build the run's
 * record, keep the run's data and append its measurement line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runCommand } from '../apps/install.ts';
import type { Brief } from './brief.ts';
import { appendMeasurement } from './measurement.ts';
import type { ModelChannelEvent } from './model-channel.ts';
import { parseJsonText } from './parse.ts';
import { assertNoPlantedLinks } from './planted-links.ts';
import type { Provenance } from './provenance.ts';
import { browserEvents, readNetLog } from './recorder/chromium-netlog.ts';
import { appendBrowserEvents, readNetworkRecord } from './recorder/network-record.ts';
import { readBuilderReport } from './report.ts';
import type { BuilderRunDirs } from './round-paths.ts';
import { BUILDER_LOG, phaseResultSchema, type PhaseResult } from './run-phase.ts';
import { measurementLine, runRecord, type RunIdentity, type RunRecord } from './run-record.ts';
import { copyRedacted, filesContaining, redactedText, type Secrets } from './token-scan.ts';
import { usageFrom } from './usage.ts';

export const RUN_PHASE_LOG = '02-run-phase.log';

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
export function tokenFoundIn(dirs: BuilderRunDirs, secrets: readonly string[]): string[] {
  const found = new Set(secrets.flatMap((secret) => keptPaths(dirs).flatMap((path) => filesContaining(path, secret))));
  return [...found].map((path) => relative(dirs.root, path)).sort();
}

const isInApp = (path: string) => path === 'app' || path.startsWith('app/');

/**
 * Copies what the harness keeps of the run into the data root, with the
 * token's value replaced wherever it turns up. The app is packed without
 * node_modules, and withheld when any file of it held the token.
 */
export async function keep(record: RunRecord, dirs: BuilderRunDirs, dataDir: string, token: Secrets): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'report.json'), redactedText(`${JSON.stringify(record, null, 2)}\n`, token));
  copyRedacted(dirs.briefJson, join(dataDir, 'brief.json'), token);
  copyRedacted(dirs.networkLog, join(dataDir, 'network.jsonl'), token);
  copyRedacted(dirs.logs, join(dataDir, 'logs'), token);
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

/** Ends a run whose sandbox has stopped: merges, scans, keeps and measures it. Resolves its record. */
export async function finishRun(input: FinishInput, end: RunEnd): Promise<RunRecord> {
  const { dirs, channel } = end;
  mergeRecords(dirs, channel);
  writeFileSync(join(dirs.logs, RUN_PHASE_LOG), end.phaseOutput);
  const found = tokenFoundIn(dirs, input.scanned);
  if (found.length > 0) input.say(tokenNotice(input.identity.run, found));
  const record = runRecord({
    identity: input.identity,
    brief: input.brief,
    provenance: input.provenance,
    startedAt: end.startedAt,
    endedAt: new Date(),
    exit: readPhaseResult(dirs),
    report: readBuilderReport(dirs.report),
    record: readNetworkRecord(dirs.networkLog),
    channel,
    usage: usageFrom(readIfExists(join(dirs.logs, BUILDER_LOG))),
    tokenFoundIn: found,
  });
  await keep(record, dirs, end.dataDir, input.scanned);
  appendMeasurement(end.measurements, measurementLine(record));
  return record;
}
