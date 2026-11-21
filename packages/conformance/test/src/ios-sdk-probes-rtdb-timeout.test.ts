import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  runIosOracleProbe,
  type IosAdminAuthAdapter,
} from '../../src/ios-oracle-runtime.ts';
import {
  DEFAULT_IOS_AUTH_SIM_TIMEOUT_MS,
  DEFAULT_IOS_FIRESTORE_SIM_TIMEOUT_MS,
  DEFAULT_IOS_RTDB_CLI_TIMEOUT_MS,
  DEFAULT_IOS_SIMCTL_TIMEOUT_MS,
  defaultExecuteAuthSim,
  defaultExecuteFirestoreSim,
  defaultExecuteRtdbCli,
  defaultQueryAvailableSimulatorsJson,
} from '../../src/ios-oracle-simulator.ts';
import type { OracleServiceAccount } from '../../src/oracle-credential.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = join(HERE, '..', '..');
const RTDB_CLI_DIR = join(CONFORMANCE_ROOT, 'rigs', 'native-ios-oracle', 'rtdb-cli');

const SYNTHETIC_SERVICE_ACCOUNT: OracleServiceAccount = {
  kind: 'application-default',
  project_id: 'demo-oracle-project',
  client_email: 'capture-sa@demo-oracle-project.iam.gserviceaccount.com',
  credential: {
    getAccessToken: async () => ({ access_token: 'synthetic-token', expires_in: 3600 }),
  },
};

function detectSwiftFrontendForParse(): string | null {
  const localFrontend = join(homedir(), '.local', 'swift', 'usr', 'bin', 'swift-frontend');
  if (existsSync(localFrontend)) {
    return localFrontend;
  }
  const pathFrontend = Bun.which('swift-frontend');
  if (pathFrontend !== null) {
    return pathFrontend;
  }
  const swiftc = Bun.which('swiftc');
  if (swiftc !== null) {
    const siblingFrontend = join(dirname(realpathSync(swiftc)), 'swift-frontend');
    if (existsSync(siblingFrontend)) {
      return siblingFrontend;
    }
    return swiftc;
  }
  return null;
}

async function runSingleProcessSwiftParse(
  swiftParser: string,
  swiftFiles: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([swiftParser, '-parse', ...swiftFiles], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdoutText}\n${stderrText}` };
}

function writeExecutableScript(scriptPath: string, body: string): void {
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, 'utf8');
  chmodSync(scriptPath, 0o755);
}

describe('iOS oracle spawnSync hard timeouts and ETIMEDOUT diagnostic preservation', () => {
  it('exports bounded default timeout constants for simctl, RtdbOracleCLI, Auth, and Firestore spawns', () => {
    expect(DEFAULT_IOS_SIMCTL_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_IOS_RTDB_CLI_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_IOS_AUTH_SIM_TIMEOUT_MS).toBe(900_000);
    expect(DEFAULT_IOS_FIRESTORE_SIM_TIMEOUT_MS).toBe(1_200_000);
  });

  it('kills hung RtdbOracleCLI spawns on timeout and preserves step breadcrumbs and FirebaseDatabase diagnostics', () => {
    const tmpRoot = createPrivateJobTmpDir('ios-rtdb-timeout-test', process.env);
    try {
      const binDir = join(tmpRoot, 'bin');
      const pkgDir = join(tmpRoot, 'pkg');
      const scratchDir = join(tmpRoot, 'scratch');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(pkgDir, { recursive: true });

      writeExecutableScript(
        join(binDir, 'swift'),
        [
          'echo "Building for debugging..."',
          'echo "[rtdb-oracle-cli] step: wave4-live:handshake-and-info-connected" >&2',
          'echo "2026-11-21 [FirebaseDatabase][I-RDB038012] Listener stalled in test" >&2',
          'sleep 5',
        ].join('\n'),
      );

      let caughtError: (Error & { output?: string }) | null = null;
      const basePath = process.env.PATH ?? '/usr/bin:/bin';
      try {
        defaultExecuteRtdbCli({
          stagedPackageDir: pkgDir,
          scratchCacheDir: scratchDir,
          inputPath: join(pkgDir, 'in.json'),
          outputPath: join(pkgDir, 'out.json'),
          env: { PATH: `${binDir}:${basePath}` },
          timeoutMs: 80,
        });
      } catch (err) {
        caughtError = err as Error & { output?: string };
      }

      expect(caughtError).not.toBeNull();
      if (caughtError !== null) {
        expect(caughtError.message).toContain('SwiftPM RtdbOracleCLI (timed out after 80ms)');
        expect(caughtError.message).toContain('Diagnostic highlights:');
        expect(caughtError.message).toContain(
          '[rtdb-oracle-cli] step: wave4-live:handshake-and-info-connected',
        );
        expect(caughtError.message).toContain('[FirebaseDatabase][I-RDB038012]');
        expect(caughtError.output).toContain('Building for debugging...');
      }

      let envTimeoutError: Error | null = null;
      try {
        defaultExecuteRtdbCli({
          stagedPackageDir: pkgDir,
          scratchCacheDir: scratchDir,
          inputPath: join(pkgDir, 'in.json'),
          outputPath: join(pkgDir, 'out.json'),
          env: {
            PATH: `${binDir}:${basePath}`,
            PYRIC_IOS_RTDB_CLI_TIMEOUT_MS: '75',
          },
        });
      } catch (err) {
        envTimeoutError = err as Error;
      }
      expect(envTimeoutError).not.toBeNull();
      if (envTimeoutError !== null) {
        expect(envTimeoutError.message).toContain('timed out after 75ms');
      }
    } finally {
      removePrivateJobTmpDir(tmpRoot, process.env);
    }
  });

  it('enforces hard timeouts on simctl and xcodebuild spawns and deletes mid-run Auth UIDs after ETIMEDOUT', async () => {
    const tmpRoot = createPrivateJobTmpDir('ios-sim-timeout-test', process.env);
    try {
      const binDir = join(tmpRoot, 'bin');
      const pkgDir = join(tmpRoot, 'pkg');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(pkgDir, { recursive: true });

      writeExecutableScript(
        join(binDir, 'xcrun'),
        'echo "xcrun simctl stalled" >&2\nsleep 5',
      );
      writeExecutableScript(
        join(binDir, 'xcodebuild'),
        [
          'echo "Test Suite started"',
          'echo "PYRIC_IOS_ORACLE_CLEANUP_UID:uid-before-xcodebuild-timeout"',
          'echo "xcodebuild: error: simulated hang after creating test user" >&2',
          'sleep 5',
        ].join('\n'),
      );

      const basePath = process.env.PATH ?? '/usr/bin:/bin';
      const envWithFakeTools = { PATH: `${binDir}:${basePath}` };

      expect(() => defaultQueryAvailableSimulatorsJson(envWithFakeTools, 70)).toThrow(
        /xcrun simctl list devices \(timed out after 70ms\)/,
      );

      expect(() =>
        defaultExecuteFirestoreSim({
          stagedPackageDir: pkgDir,
          derivedDataDir: join(tmpRoot, 'fs-dd'),
          clonedPackagesDir: join(tmpRoot, 'spm'),
          destination: 'platform=iOS Simulator,id=SIM-TIMEOUT-1',
          env: envWithFakeTools,
          timeoutMs: 70,
        }),
      ).toThrow(/xcodebuild FirestoreOracleHostedTests \(timed out after 70ms\)/);

      const deletedUids: string[] = [];
      const mockAdmin: IosAdminAuthAdapter = {
        createCustomToken: async () => 'unused-token',
        deleteUser: async (uid) => {
          deletedUids.push(uid);
        },
        dispose: async () => {},
      };

      await expect(
        runIosOracleProbe({
          probeId: 'auth-swift-email-password-profile-and-listeners',
          mode: 'ios-sim-auth',
          needsCustomToken: false,
          deps: {
            platform: 'darwin',
            env: {
              PATH: `${binDir}:${basePath}`,
              PYRIC_IOS_AUTH_SIM_TIMEOUT_MS: '80',
            },
            loadServiceAccount: async () => SYNTHETIC_SERVICE_ACCOUNT,
            resolveWebConfig: async () => ({
              apiKey: 'demo-key',
              authDomain: 'demo-oracle-project.firebaseapp.com',
              projectId: 'demo-oracle-project',
              appId: '1:123456789012:web:abcdef0123456789abcdef',
              messagingSenderId: '123456789012',
            }),
            openAdminAuth: async () => mockAdmin,
            queryAvailableSimulatorsJson: () =>
              JSON.stringify({
                devices: {
                  'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                    { udid: 'SIM-TIMEOUT-2', name: 'iPhone 17', state: 'Booted', isAvailable: true },
                  ],
                },
              }),
            executeAuthSim: (req) => defaultExecuteAuthSim(req),
          },
        }),
      ).rejects.toThrow(/xcodebuild AuthOracleHostedTests \(timed out after 80ms\)/);

      expect(deletedUids).toEqual(['uid-before-xcodebuild-timeout']);
    } finally {
      removePrivateJobTmpDir(tmpRoot, process.env);
    }
  });
});

describe('RtdbOracleCLI .info/nonexistent_key hang fix, internal watchdog, and Swift syntax', () => {
  it(
    'replaces blocking observeSingleEvent on unknown .info key with non-blocking observer, arms watchdog + orphan guard, and parses cleanly',
    async () => {
      const mainSwiftPath = join(RTDB_CLI_DIR, 'Sources', 'RtdbOracleCLI', 'main.swift');
      const wave2SwiftPath = join(
        RTDB_CLI_DIR,
        'Sources',
        'RtdbOracleCLI',
        'RtdbWave2Probes.swift',
      );
      const wave4NavSwiftPath = join(
        RTDB_CLI_DIR,
        'Sources',
        'RtdbOracleCLI',
        'RtdbWave4NavigationAndSnapshotProbes.swift',
      );
      const wave4LiveSwiftPath = join(
        RTDB_CLI_DIR,
        'Sources',
        'RtdbOracleCLI',
        'RtdbWave4ListenersAndOnDisconnectProbes.swift',
      );

      const mainSwift = readFileSync(mainSwiftPath, 'utf8');
      const wave2Swift = readFileSync(wave2SwiftPath, 'utf8');
      const wave4NavSwift = readFileSync(wave4NavSwiftPath, 'utf8');
      const wave4LiveSwift = readFileSync(wave4LiveSwiftPath, 'utf8');

      expect(mainSwift).toContain('func markRtdbStep(');
      expect(mainSwift).toContain('func startRtdbWatchdogs(');
      expect(mainSwift).toContain('PYRIC_IOS_RTDB_CLI_WATCHDOG_SEC');
      expect(mainSwift).toContain('getppid()');
      expect(mainSwift).toContain('Darwin.exit(124)');
      expect(mainSwift).toContain('Darwin.exit(125)');

      expect(wave2Swift).toContain('markRtdbStep(');
      expect(wave4NavSwift).toContain('markRtdbStep(');
      expect(wave4LiveSwift).toContain('markRtdbStep(');

      expect(wave4LiveSwift).not.toContain('observeSingleValueAsync(unknownInfoRef)');
      expect(wave4LiveSwift).toContain('let unknownInfoHandle = unknownInfoRef.observe(.value)');
      expect(
        wave4LiveSwift.split('unknownInfoRef.removeObserver(withHandle: unknownInfoHandle)').length -
          1,
      ).toBe(2);
      expect(wave4LiveSwift).toContain('"infoUnknownKeyFiredValueEvent"');

      for (const src of [mainSwift, wave2Swift, wave4NavSwift]) {
        expect(src).not.toContain('.info/nonexistent_key');
      }

      const swiftParser = detectSwiftFrontendForParse();
      if (swiftParser !== null) {
        const parseResult = await runSingleProcessSwiftParse(swiftParser, [
          join(RTDB_CLI_DIR, 'Package.swift'),
          mainSwiftPath,
          wave2SwiftPath,
          wave4NavSwiftPath,
          wave4LiveSwiftPath,
        ]);
        expect(parseResult.exitCode, parseResult.output).toBe(0);
      }
    },
    90_000,
  );
});
