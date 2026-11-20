/**
 * Apple / iOS Simulator discovery, SwiftPM template staging, `swift run` /
 * `xcodebuild test` command construction, and base64 result-envelope parsing for
 * `packages/conformance/src/ios-oracle-runtime.ts`.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

const RESULT_LINE_PREFIX = 'PYRIC_IOS_ORACLE_RESULT_B64:';
const CLEANUP_UID_LINE_PREFIX = 'PYRIC_IOS_ORACLE_CLEANUP_UID:';

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
}

export interface IosAuthSimRequest {
  stagedPackageDir: string;
  derivedDataDir: string;
  clonedPackagesDir: string;
  destination: string;
  env: NodeJS.ProcessEnv;
}

interface SimctlDeviceRecord {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
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
}

function parseIosRuntimeVersionTuple(runtimeKey: string): number[] | null {
  const match = /SimRuntime\.iOS-([0-9]+(?:-[0-9]+)*)$/.exec(runtimeKey);
  if (!match) {
    return null;
  }
  const versionGroup = match[1];
  if (versionGroup === undefined) {
    return null;
  }
  return versionGroup.split('-').map((segment) => Number.parseInt(segment, 10));
}

function compareVersionTuplesDescending(left: readonly number[], right: readonly number[]): number {
  const maxLen = Math.max(left.length, right.length);
  for (let i = 0; i < maxLen; i += 1) {
    let leftPart = 0;
    const rawLeft = left[i];
    if (rawLeft !== undefined) {
      leftPart = rawLeft;
    }
    let rightPart = 0;
    const rawRight = right[i];
    if (rawRight !== undefined) {
      rightPart = rawRight;
    }
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
    if (tuple === null || !Array.isArray(value)) {
      continue;
    }
    iosRuntimes.push({
      runtimeKey,
      tuple,
      list: value as SimctlDeviceRecord[],
    });
  }

  iosRuntimes.sort((a, b) => compareVersionTuplesDescending(a.tuple, b.tuple));

  const candidates: Array<IosSimulatorSelection & { isIphone: boolean; isBooted: boolean }> = [];
  for (const runtime of iosRuntimes) {
    for (const rawDevice of runtime.list) {
      if (typeof rawDevice !== 'object' || rawDevice === null) {
        continue;
      }
      if (rawDevice.isAvailable === false) {
        continue;
      }
      if (typeof rawDevice.udid !== 'string' || rawDevice.udid.trim() === '') {
        continue;
      }
      if (typeof rawDevice.name !== 'string' || rawDevice.name.trim() === '') {
        continue;
      }
      const udid = rawDevice.udid.trim();
      const name = rawDevice.name.trim();
      const isIphone = name.startsWith('iPhone');
      const isBooted = rawDevice.state === 'Booted';
      candidates.push({
        udid,
        name,
        runtimeKey: runtime.runtimeKey,
        destination: `platform=iOS Simulator,id=${udid}`,
        isIphone,
        isBooted,
      });
    }
  }

  const bootedIphone = candidates.find((item) => item.isIphone && item.isBooted);
  if (bootedIphone) {
    return {
      udid: bootedIphone.udid,
      name: bootedIphone.name,
      runtimeKey: bootedIphone.runtimeKey,
      destination: bootedIphone.destination,
    };
  }

  const firstIphone = candidates.find((item) => item.isIphone);
  if (firstIphone) {
    return {
      udid: firstIphone.udid,
      name: firstIphone.name,
      runtimeKey: firstIphone.runtimeKey,
      destination: firstIphone.destination,
    };
  }

  const fallbackAny = candidates[0];
  if (fallbackAny) {
    return {
      udid: fallbackAny.udid,
      name: fallbackAny.name,
      runtimeKey: fallbackAny.runtimeKey,
      destination: fallbackAny.destination,
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

function formatSpawnFailure(toolLabel: string, status: number | null, stdout: string, stderr: string): Error {
  const combined = `${stdout}\n${stderr}`.trim();
  const excerpt = combined.split('\n').slice(-40).join('\n');
  const err = new Error(`${toolLabel} exited with status ${String(status)}:\n${excerpt}`) as Error & {
    output?: string;
  };
  err.output = combined;
  return err;
}

export function defaultQueryAvailableSimulatorsJson(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  let stdout = '';
  if (typeof result.stdout === 'string') {
    stdout = result.stdout;
  }
  let stderr = '';
  if (typeof result.stderr === 'string') {
    stderr = result.stderr;
  }
  if (result.status !== 0) {
    throw formatSpawnFailure('xcrun simctl list devices', result.status, stdout, stderr);
  }
  return stdout;
}

export function buildRtdbSwiftRunArgs(request: IosRtdbCliRequest): string[] {
  return [
    'run',
    '--package-path',
    request.stagedPackageDir,
    '--scratch-path',
    request.scratchCacheDir,
    'RtdbOracleCLI',
    '--input',
    request.inputPath,
    '--output',
    request.outputPath,
  ];
}

export function defaultExecuteRtdbCli(request: IosRtdbCliRequest): string {
  mkdirSync(request.scratchCacheDir, { recursive: true });
  const args = buildRtdbSwiftRunArgs(request);
  const result = spawnSync('swift', args, {
    cwd: request.stagedPackageDir,
    env: request.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  let stdout = '';
  if (typeof result.stdout === 'string') {
    stdout = result.stdout;
  }
  let stderr = '';
  if (typeof result.stderr === 'string') {
    stderr = result.stderr;
  }
  if (result.status !== 0) {
    throw formatSpawnFailure('SwiftPM RtdbOracleCLI', result.status, stdout, stderr);
  }
  return `${stdout}\n${stderr}`;
}

export function buildAuthSimXcodebuildArgs(request: IosAuthSimRequest): string[] {
  return [
    'test',
    '-scheme',
    'PyricIosAuthOracle',
    '-destination',
    request.destination,
    '-derivedDataPath',
    request.derivedDataDir,
    '-clonedSourcePackagesDirPath',
    request.clonedPackagesDir,
    '-only-testing:AuthOracleSimTests/AuthOracleSimTests/testCaptureSelectedOracleProbe',
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGNING_IDENTITY=',
  ];
}

export function defaultExecuteAuthSim(request: IosAuthSimRequest): string {
  mkdirSync(request.derivedDataDir, { recursive: true });
  mkdirSync(request.clonedPackagesDir, { recursive: true });
  const args = buildAuthSimXcodebuildArgs(request);
  const result = spawnSync('xcodebuild', args, {
    cwd: request.stagedPackageDir,
    env: request.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  let stdout = '';
  if (typeof result.stdout === 'string') {
    stdout = result.stdout;
  }
  let stderr = '';
  if (typeof result.stderr === 'string') {
    stderr = result.stderr;
  }
  if (result.status !== 0) {
    throw formatSpawnFailure('xcodebuild AuthOracleSimTests', result.status, stdout, stderr);
  }
  return `${stdout}\n${stderr}`;
}
