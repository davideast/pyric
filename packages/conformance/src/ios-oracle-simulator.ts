/**
 * Apple / iOS Simulator discovery, SwiftPM template staging, `swift run` /
 * `xcodebuild test` command construction, and base64 result-envelope parsing for
 * `packages/conformance/src/ios-oracle-runtime.ts`.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RESULT_LINE_PREFIX = 'PYRIC_IOS_ORACLE_RESULT_B64:';
const CLEANUP_UID_LINE_PREFIX = 'PYRIC_IOS_ORACLE_CLEANUP_UID:';
const DEFAULT_IOS_GOOGLE_APP_ID = '1:000000000000:ios:0000000000000000';
const ZERO_HEX_BUNDLE_HASH = '0000000000000000';
const VALID_FIR_APP_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_ID_FOUR_PART_PATTERN = /^1:([0-9]{1,18}):([A-Za-z]+):(.+)$/;
const APP_ID_PROJECT_PREFIX_PATTERN = /^1:([0-9]{1,18}):/;
const HEX_DIGITS_PATTERN = /^[0-9a-fA-F]+$/;
const DECIMAL_SENDER_ID_PATTERN = /^[0-9]{1,18}$/;
const SPAWN_TAIL_LINE_LIMIT = 120;
const SPAWN_HIGHLIGHT_LINE_LIMIT = 40;
export const DEFAULT_IOS_SIMCTL_TIMEOUT_MS = 60_000;
export const DEFAULT_IOS_RTDB_CLI_TIMEOUT_MS = 600_000;
export const DEFAULT_IOS_AUTH_SIM_TIMEOUT_MS = 900_000;
export const DEFAULT_IOS_FIRESTORE_SIM_TIMEOUT_MS = 1_200_000;

function extractDecimalProjectNumber(candidate: string | undefined): string | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  if (DECIMAL_SENDER_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Normalizes a Firebase `appId` (including Web `1:<num>:web:<22-hex>`, Android,
 * or macOS IDs returned by `resolveProbeWebConfig`) into the strict format
 * enforced by `+[FIRApp validateAppID:]` in `FirebaseCore` (`FIRApp.m`):
 * `1:<decimal-project-number>:ios:<1-to-16-lowercase-hex-digits>`.
 */
export function normalizeIosOracleGoogleAppId(
  rawAppId: string | undefined,
  gcmSenderId: string,
): string {
  if (typeof rawAppId === 'string') {
    const trimmed = rawAppId.trim();
    const fourPartMatch = APP_ID_FOUR_PART_PATTERN.exec(trimmed);
    if (fourPartMatch !== null) {
      const projectNumber = fourPartMatch[1];
      const platform = fourPartMatch[2];
      const suffix = fourPartMatch[3];
      if (
        projectNumber !== undefined &&
        platform !== undefined &&
        suffix !== undefined &&
        HEX_DIGITS_PATTERN.test(suffix)
      ) {
        const lowerHex = suffix.toLowerCase();
        if (platform.toLowerCase() === 'ios' && lowerHex.length >= 1 && lowerHex.length <= 16) {
          return `1:${projectNumber}:ios:${lowerHex}`;
        }
        const boundedHex = lowerHex.slice(0, 16).padEnd(16, '0');
        return `1:${projectNumber}:ios:${boundedHex}`;
      }
    }
    const prefixMatch = APP_ID_PROJECT_PREFIX_PATTERN.exec(trimmed);
    if (prefixMatch !== null && prefixMatch[1] !== undefined) {
      return `1:${prefixMatch[1]}:ios:${ZERO_HEX_BUNDLE_HASH}`;
    }
  }

  const senderProjectNumber = extractDecimalProjectNumber(gcmSenderId);
  if (senderProjectNumber !== null) {
    return `1:${senderProjectNumber}:ios:${ZERO_HEX_BUNDLE_HASH}`;
  }
  return DEFAULT_IOS_GOOGLE_APP_ID;
}

/**
 * Validates a `FirebaseApp` name or `runId` token against `FIRApp.m`'s
 * character-set check (`[A-Za-z0-9_-]+`).
 */
export function assertValidIosOracleAppName(appName: string): string {
  if (!VALID_FIR_APP_NAME_PATTERN.test(appName)) {
    throw new Error(
      `Invalid FirebaseApp name token '${appName}': FirebaseCore allows only ASCII letters, digits, hyphens, and underscores.`,
    );
  }
  return appName;
}

export interface IosSimulatorSelection {
  udid: string;
  name: string;
  runtimeKey: string;
  destination: string;
}

export interface IosRtdbCliRequest {
  stagedPackageDir: string;
  scratchCacheDir: string;
  inputPath: string;
  outputPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface IosHostedSimRequest {
  stagedPackageDir: string;
  derivedDataDir: string;
  clonedPackagesDir: string;
  destination: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type IosAuthSimRequest = IosHostedSimRequest;
export type IosFirestoreSimRequest = IosHostedSimRequest;

interface SimctlDeviceRecord {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
}

function materializeStagedXcodeProject(stagedHostDir: string): void {
  const templateDir = join(stagedHostDir, 'ProjectTemplate');
  const pbxTemplate = join(templateDir, 'project.pbxproj');
  if (!existsSync(pbxTemplate)) {
    return;
  }
  for (const entry of readdirSync(templateDir).sort()) {
    if (!entry.endsWith('.xcscheme')) {
      continue;
    }
    const projectName = entry.slice(0, -'.xcscheme'.length);
    const xcodeprojDir = join(stagedHostDir, `${projectName}.xcodeproj`);
    const schemesDir = join(xcodeprojDir, 'xcshareddata', 'xcschemes');
    mkdirSync(schemesDir, { recursive: true });
    copyFileSync(pbxTemplate, join(xcodeprojDir, 'project.pbxproj'));
    copyFileSync(join(templateDir, entry), join(schemesDir, entry));
  }
}

export function stageIosPackageTemplate(sourceDir: string, targetDir: string): void {
  const stat = lstatSync(sourceDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Invalid iOS oracle template directory: ${sourceDir}`);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir).sort()) {
    if (entry === '.build' || entry === '.swiftpm' || entry === 'Package.resolved') {
      continue;
    }
    const sourceEntry = join(sourceDir, entry);
    const targetEntry = join(targetDir, entry);
    const entryStat = lstatSync(sourceEntry);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Refusing symlink inside iOS oracle template: ${sourceEntry}`);
    }
    if (entryStat.isDirectory()) {
      stageIosPackageTemplate(sourceEntry, targetEntry);
    } else if (entryStat.isFile()) {
      copyFileSync(sourceEntry, targetEntry);
    }
  }
  materializeStagedXcodeProject(targetDir);
}

function parseIosRuntimeVersionTuple(runtimeKey: string): number[] | null {
  const match = /SimRuntime\.iOS-([0-9]+(?:-[0-9]+)*)$/.exec(runtimeKey);
  if (!match || match[1] === undefined) {
    return null;
  }
  return match[1].split('-').map((segment) => Number.parseInt(segment, 10));
}

function compareVersionTuplesDescending(left: readonly number[], right: readonly number[]): number {
  const maxLen = Math.max(left.length, right.length);
  for (let i = 0; i < maxLen; i += 1) {
    const leftPart = left[i] ?? 0;
    const rightPart = right[i] ?? 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }
  return 0;
}

export function selectAvailableIosSimulatorDestination(simctlJson: string): IosSimulatorSelection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(simctlJson);
  } catch (err) {
    throw new Error(`Failed to parse xcrun simctl JSON output: ${String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('xcrun simctl output must be a JSON object with a devices map');
  }
  const devicesMap = (parsed as { devices?: unknown }).devices;
  if (typeof devicesMap !== 'object' || devicesMap === null || Array.isArray(devicesMap)) {
    throw new Error('xcrun simctl output is missing a valid devices map');
  }

  const iosRuntimes: Array<{ runtimeKey: string; tuple: number[]; list: SimctlDeviceRecord[] }> = [];
  for (const [runtimeKey, value] of Object.entries(devicesMap as Record<string, unknown>)) {
    const tuple = parseIosRuntimeVersionTuple(runtimeKey);
    if (tuple !== null && Array.isArray(value)) {
      iosRuntimes.push({ runtimeKey, tuple, list: value as SimctlDeviceRecord[] });
    }
  }
  iosRuntimes.sort((a, b) => compareVersionTuplesDescending(a.tuple, b.tuple));

  const candidates: Array<IosSimulatorSelection & { isIphone: boolean; isBooted: boolean }> = [];
  for (const runtime of iosRuntimes) {
    for (const rawDevice of runtime.list) {
      if (typeof rawDevice !== 'object' || rawDevice === null || rawDevice.isAvailable === false) {
        continue;
      }
      if (typeof rawDevice.udid !== 'string' || typeof rawDevice.name !== 'string') {
        continue;
      }
      const udid = rawDevice.udid.trim();
      const name = rawDevice.name.trim();
      if (udid === '' || name === '') {
        continue;
      }
      candidates.push({
        udid,
        name,
        runtimeKey: runtime.runtimeKey,
        destination: `platform=iOS Simulator,id=${udid}`,
        isIphone: name.startsWith('iPhone'),
        isBooted: rawDevice.state === 'Booted',
      });
    }
  }

  let selected = candidates.find((item) => item.isIphone && item.isBooted);
  if (selected === undefined) {
    selected = candidates.find((item) => item.isIphone);
  }
  if (selected === undefined) {
    selected = candidates[0];
  }
  if (selected !== undefined) {
    return {
      udid: selected.udid,
      name: selected.name,
      runtimeKey: selected.runtimeKey,
      destination: selected.destination,
    };
  }

  throw new Error(
    'No available iOS Simulator device found via `xcrun simctl list devices available -j`. Install an iOS Simulator runtime in Xcode before running ios-sdk-probes.',
  );
}

export function extractIosOracleResultFromOutput(combinedOutput: string): Record<string, unknown> {
  const lines = combinedOutput.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const markerIndex = line.indexOf(RESULT_LINE_PREFIX);
    if (markerIndex === -1) {
      continue;
    }
    const encoded = line.slice(markerIndex + RESULT_LINE_PREFIX.length).trim();
    if (encoded === '') {
      continue;
    }
    const jsonText = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Decoded PYRIC_IOS_ORACLE_RESULT_B64 payload is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  throw new Error(
    `Missing ${RESULT_LINE_PREFIX}<base64> marker in iOS oracle runner output`,
  );
}

export function extractIosOracleCleanupUids(combinedOutput: string): string[] {
  const uids: string[] = [];
  const seen = new Set<string>();
  for (const line of combinedOutput.split(/\r?\n/)) {
    const markerIndex = line.indexOf(CLEANUP_UID_LINE_PREFIX);
    if (markerIndex === -1) {
      continue;
    }
    const uid = line.slice(markerIndex + CLEANUP_UID_LINE_PREFIX.length).trim();
    if (uid !== '' && !seen.has(uid)) {
      seen.add(uid);
      uids.push(uid);
    }
  }
  return uids;
}

function isBenignCompilerCommandLine(trimmedLine: string): boolean {
  if (trimmedLine.startsWith('CompileC ') || trimmedLine.startsWith('SwiftCompile ')) {
    return true;
  }
  if (trimmedLine.includes(' -fmodules ') || trimmedLine.includes(' -module-name ')) {
    return true;
  }
  return false;
}

const DIAGNOSTIC_SUBSTRINGS = [
  '*** Terminating app',
  '*** First throw call stack',
  'NSException',
  'libc++abi:',
  'terminating due to uncaught exception',
  'terminating with uncaught exception',
  'Fatal error:',
  'Assertion failure',
  'XCTFail',
  'failed - ',
];

function isDiagnosticHighlightLine(trimmedLine: string): boolean {
  if (trimmedLine === '' || isBenignCompilerCommandLine(trimmedLine)) {
    return false;
  }
  for (const token of DIAGNOSTIC_SUBSTRINGS) {
    if (trimmedLine.includes(token)) {
      return true;
    }
  }
  if (
    /\[Firebase(?:Core|Auth|Firestore|Database)\]/.test(trimmedLine) ||
    /I-(?:COR|AUT|FST|RDB)[0-9]{6}/.test(trimmedLine)
  ) {
    return true;
  }
  return (
    trimmedLine.startsWith('[rtdb-oracle-cli] error:') ||
    trimmedLine.startsWith('[rtdb-oracle-cli] step:') ||
    trimmedLine.startsWith('xcodebuild: error:') ||
    /\berror:\s/.test(trimmedLine)
  );
}

export function formatIosOracleSpawnFailure(
  toolLabel: string,
  status: number | null,
  stdout: string,
  stderr: string,
): Error & { output?: string } {
  const combined = `${stdout}\n${stderr}`.trim();
  const lines = combined.split(/\r?\n/);
  const highlights: string[] = [];
  const seenHighlights = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      continue;
    }
    const trimmed = rawLine.trim();
    if (!isDiagnosticHighlightLine(trimmed)) {
      continue;
    }
    if (!seenHighlights.has(trimmed) && highlights.length < SPAWN_HIGHLIGHT_LINE_LIMIT) {
      seenHighlights.add(trimmed);
      highlights.push(rawLine);
    }
    if (trimmed.includes('*** Terminating app') && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine !== undefined) {
        const nextTrimmed = nextLine.trim();
        if (
          nextTrimmed !== '' &&
          !seenHighlights.has(nextTrimmed) &&
          highlights.length < SPAWN_HIGHLIGHT_LINE_LIMIT
        ) {
          seenHighlights.add(nextTrimmed);
          highlights.push(nextLine);
        }
      }
    }
  }

  const tailExcerpt = lines.slice(-SPAWN_TAIL_LINE_LIMIT).join('\n');
  const sections: string[] = [`${toolLabel} exited with status ${String(status)}:`];
  if (highlights.length > 0) {
    sections.push(`Diagnostic highlights:\n${highlights.join('\n')}`);
  }
  sections.push(`Recent output tail:\n${tailExcerpt}`);

  const err = new Error(sections.join('\n')) as Error & {
    output?: string;
  };
  err.output = combined;
  return err;
}

function resolveSpawnTimeoutMs(
  overrideMs: number | undefined,
  envRaw: string | undefined,
  defaultMs: number,
): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.floor(overrideMs);
  }
  if (typeof envRaw === 'string' && DECIMAL_SENDER_ID_PATTERN.test(envRaw.trim())) {
    const parsed = Number.parseInt(envRaw.trim(), 10);
    if (parsed > 0) {
      return parsed;
    }
  }
  return defaultMs;
}

function readVerifiedSpawnStreams(
  toolLabel: string,
  result: SpawnSyncReturns<string>,
  timeoutMs: number,
): { stdout: string; stderr: string } {
  let stdout = '';
  if (typeof result.stdout === 'string') {
    stdout = result.stdout;
  }
  let stderr = '';
  if (typeof result.stderr === 'string') {
    stderr = result.stderr;
  }
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw formatIosOracleSpawnFailure(
        `${toolLabel} (timed out after ${String(timeoutMs)}ms)`,
        result.status,
        stdout,
        stderr,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw formatIosOracleSpawnFailure(toolLabel, result.status, stdout, stderr);
  }
  return { stdout, stderr };
}

export function defaultQueryAvailableSimulatorsJson(
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): string {
  const resolvedTimeout = resolveSpawnTimeoutMs(
    timeoutMs,
    env.PYRIC_IOS_SIMCTL_TIMEOUT_MS,
    DEFAULT_IOS_SIMCTL_TIMEOUT_MS,
  );
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: resolvedTimeout,
    killSignal: 'SIGKILL',
  });
  return readVerifiedSpawnStreams('xcrun simctl list devices', result, resolvedTimeout).stdout;
}

export function buildRtdbSwiftRunArgs(request: IosRtdbCliRequest): string[] {
  return [
    'run', '--package-path', request.stagedPackageDir,
    '--scratch-path', request.scratchCacheDir, 'RtdbOracleCLI',
    '--input', request.inputPath, '--output', request.outputPath,
  ];
}

export function defaultExecuteRtdbCli(request: IosRtdbCliRequest): string {
  mkdirSync(request.scratchCacheDir, { recursive: true });
  const resolvedTimeout = resolveSpawnTimeoutMs(
    request.timeoutMs,
    request.env.PYRIC_IOS_RTDB_CLI_TIMEOUT_MS,
    DEFAULT_IOS_RTDB_CLI_TIMEOUT_MS,
  );
  const result = spawnSync('swift', buildRtdbSwiftRunArgs(request), {
    cwd: request.stagedPackageDir,
    env: request.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: resolvedTimeout,
    killSignal: 'SIGKILL',
  });
  const streams = readVerifiedSpawnStreams('SwiftPM RtdbOracleCLI', result, resolvedTimeout);
  return `${streams.stdout}\n${streams.stderr}`;
}

function buildHostedSimulatorXcodebuildArgs(
  xcodeprojPath: string,
  scheme: string,
  onlyTestingTarget: string,
  request: IosAuthSimRequest | IosFirestoreSimRequest,
): string[] {
  return [
    'test', '-project', xcodeprojPath, '-scheme', scheme,
    '-destination', request.destination, '-derivedDataPath', request.derivedDataDir,
    '-clonedSourcePackagesDirPath', request.clonedPackagesDir,
    '-collect-test-diagnostics', 'never', `-only-testing:${onlyTestingTarget}`,
    'ONLY_ACTIVE_ARCH=YES', 'COMPILER_INDEX_STORE_ENABLE=NO',
    'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGNING_ALLOWED=YES',
  ];
}

export function buildAuthSimXcodebuildArgs(request: IosAuthSimRequest): string[] {
  return buildHostedSimulatorXcodebuildArgs(
    join(request.stagedPackageDir, 'HostApp', 'AuthOracleHost.xcodeproj'),
    'AuthOracleHost',
    'AuthOracleHostedTests/AuthOracleHostedTests/testCaptureSelectedOracleProbe',
    request,
  );
}

function executeHostedSimulatorXcodebuild(
  toolLabel: string,
  args: string[],
  request: IosAuthSimRequest | IosFirestoreSimRequest,
  envVarName: string,
  defaultTimeoutMs: number,
): string {
  mkdirSync(request.derivedDataDir, { recursive: true });
  mkdirSync(request.clonedPackagesDir, { recursive: true });
  const resolvedTimeout = resolveSpawnTimeoutMs(
    request.timeoutMs,
    request.env[envVarName],
    defaultTimeoutMs,
  );
  const result = spawnSync('xcodebuild', args, {
    cwd: request.stagedPackageDir,
    env: request.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: resolvedTimeout,
    killSignal: 'SIGKILL',
  });
  const streams = readVerifiedSpawnStreams(toolLabel, result, resolvedTimeout);
  return `${streams.stdout}\n${streams.stderr}`;
}

export function defaultExecuteAuthSim(request: IosAuthSimRequest): string {
  return executeHostedSimulatorXcodebuild(
    'xcodebuild AuthOracleHostedTests',
    buildAuthSimXcodebuildArgs(request),
    request,
    'PYRIC_IOS_AUTH_SIM_TIMEOUT_MS',
    DEFAULT_IOS_AUTH_SIM_TIMEOUT_MS,
  );
}

export function buildFirestoreSimXcodebuildArgs(request: IosFirestoreSimRequest): string[] {
  return buildHostedSimulatorXcodebuildArgs(
    join(request.stagedPackageDir, 'HostApp', 'FirestoreOracleHost.xcodeproj'),
    'FirestoreOracleHost',
    'FirestoreOracleHostedTests/FirestoreOracleHostedTests/testCaptureSelectedOracleProbe',
    request,
  );
}

export function defaultExecuteFirestoreSim(request: IosFirestoreSimRequest): string {
  return executeHostedSimulatorXcodebuild(
    'xcodebuild FirestoreOracleHostedTests',
    buildFirestoreSimXcodebuildArgs(request),
    request,
    'PYRIC_IOS_FIRESTORE_SIM_TIMEOUT_MS',
    DEFAULT_IOS_FIRESTORE_SIM_TIMEOUT_MS,
  );
}
