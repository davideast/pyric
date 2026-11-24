/**
 * Isolated `firebase@13.4.0` (`@firebase/crashlytics@0.2.0`) fixture installer
 * and browser-bundle runner for offline Crashlytics web contract probes.
 *
 * Keeps all installed packages and compiled browser bundles inside
 * `~/.cache/pyric-crashlytics-web-oracle/firebase-13.4.0` so the root monorepo
 * stays pinned to its workspace `firebase` version with zero working-tree edits.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const ISOLATED_CRASHLYTICS_FIREBASE_VERSION = '13.4.0';
export const ISOLATED_CRASHLYTICS_PACKAGE_VERSION = '0.2.0';

const CACHE_MARKER_FILE = '.pyric-warm';
const LOCK_FILENAME = '.install.lock';
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 100;

export interface CrashlyticsWebFixtureInfo {
  readonly fixtureDir: string;
  readonly firebaseVersion: string;
  readonly crashlyticsVersion: string;
}

function resolveBunExecutable(): string {
  const execPath = process.execPath;
  if (typeof execPath === 'string' && execPath.endsWith('bun')) {
    return execPath;
  }
  return 'bun';
}

function resolveFixtureCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PYRIC_CRASHLYTICS_WEB_FIXTURE_DIR;
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return resolve(
    join(
      homedir(),
      '.cache',
      'pyric-crashlytics-web-oracle',
      `firebase-${ISOLATED_CRASHLYTICS_FIREBASE_VERSION}`,
    ),
  );
}

function readInstalledPackageVersion(fixtureDir: string, pkgName: string): string | null {
  const manifestPath = join(fixtureDir, 'node_modules', ...pkgName.split('/'), 'package.json');
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
    return null;
  } catch (readErr) {
    void readErr;
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (killErr) {
    return (killErr as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepBlocking(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function withFileLock<T>(lockPath: string, work: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${String(process.pid)}\n`);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (openErr) {
      const code = (openErr as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw openErr;
      }
      try {
        const ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (staleErr) {
        void staleErr;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Crashlytics fixture lock at ${lockPath}`);
      }
      sleepBlocking(LOCK_POLL_MS);
    }
  }

  try {
    return work();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch (unlinkErr) {
      void unlinkErr;
    }
  }
}

/**
 * Ensures an isolated `firebase@13.4.0` (`@firebase/crashlytics@0.2.0`) fixture
 * is installed using the host's default npm/bun registry configuration.
 */
export function ensureCrashlyticsWebFb13Fixture(
  env: NodeJS.ProcessEnv = process.env,
): CrashlyticsWebFixtureInfo {
  const fixtureDir = resolveFixtureCacheDir(env);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, CACHE_MARKER_FILE), 'crashlytics-web-fb13\n');

  const lockPath = join(fixtureDir, LOCK_FILENAME);
  return withFileLock(lockPath, () => {
    const existingFb = readInstalledPackageVersion(fixtureDir, 'firebase');
    const existingCrashlytics = readInstalledPackageVersion(fixtureDir, '@firebase/crashlytics');
    if (
      existingFb === ISOLATED_CRASHLYTICS_FIREBASE_VERSION &&
      existingCrashlytics === ISOLATED_CRASHLYTICS_PACKAGE_VERSION
    ) {
      return {
        fixtureDir,
        firebaseVersion: existingFb,
        crashlyticsVersion: existingCrashlytics,
      };
    }

    const manifest = {
      name: 'pyric-crashlytics-web-fb13-fixture',
      private: true,
      type: 'module',
      dependencies: {
        firebase: ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
      },
    };
    writeFileSync(join(fixtureDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const bunBin = resolveBunExecutable();
    const installRes = spawnSync(bunBin, ['install'], {
      cwd: fixtureDir,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (installRes.error) {
      throw installRes.error;
    }
    if (installRes.status !== 0) {
      throw new Error(
        `Isolated firebase@${ISOLATED_CRASHLYTICS_FIREBASE_VERSION} install failed (exit ${String(installRes.status)}):\n${installRes.stdout}\n${installRes.stderr}`,
      );
    }

    const installedFb = readInstalledPackageVersion(fixtureDir, 'firebase');
    const installedCrashlytics = readInstalledPackageVersion(fixtureDir, '@firebase/crashlytics');
    if (
      installedFb !== ISOLATED_CRASHLYTICS_FIREBASE_VERSION ||
      installedCrashlytics !== ISOLATED_CRASHLYTICS_PACKAGE_VERSION
    ) {
      throw new Error(
        `Unexpected isolated versions: firebase=${String(installedFb)}, @firebase/crashlytics=${String(installedCrashlytics)}`,
      );
    }

    return {
      fixtureDir,
      firebaseVersion: installedFb,
      crashlyticsVersion: installedCrashlytics,
    };
  });
}

/**
 * Bundles `sourceCode` with `--target=browser` inside the isolated `firebase@13.4.0`
 * fixture so `firebase/app` and `firebase/crashlytics` resolve their real browser
 * ESM entrypoints, then executes the bundle in an isolated subprocess.
 */
export function runBundledBrowserProbeScript<T>(
  sourceCode: string,
  env: NodeJS.ProcessEnv = process.env,
): { fixture: CrashlyticsWebFixtureInfo; result: T } {
  const fixture = ensureCrashlyticsWebFb13Fixture(env);
  const digest = createHash('sha256').update(sourceCode).digest('hex').slice(0, 16);
  const entryPath = join(fixture.fixtureDir, `probe-entry-${digest}.mjs`);
  const bundlePath = join(fixture.fixtureDir, `probe-bundle-${digest}.mjs`);
  const bunBin = resolveBunExecutable();

  const lockPath = join(fixture.fixtureDir, LOCK_FILENAME);
  withFileLock(lockPath, () => {
    if (!existsSync(bundlePath)) {
      writeFileSync(entryPath, sourceCode);
      const buildRes = spawnSync(
        bunBin,
        ['build', entryPath, '--target=browser', '--outfile', bundlePath],
        {
          cwd: fixture.fixtureDir,
          env,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (buildRes.error) {
        throw buildRes.error;
      }
      if (buildRes.status !== 0) {
        throw new Error(
          `Failed bundling Crashlytics browser probe (exit ${String(buildRes.status)}):\n${buildRes.stdout}\n${buildRes.stderr}`,
        );
      }
    }
  });

  const runRes = spawnSync(bunBin, ['run', bundlePath], {
    cwd: fixture.fixtureDir,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (runRes.error) {
    throw runRes.error;
  }
  if (runRes.status !== 0) {
    throw new Error(
      `Crashlytics browser probe exited with status ${String(runRes.status)}:\n${runRes.stdout}\n${runRes.stderr}`,
    );
  }

  const lines = runRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"__crashlyticsProbeResult":true,'));
  const payloadLine = lines[lines.length - 1];
  if (payloadLine === undefined) {
    throw new Error(`Crashlytics browser probe produced no JSON payload:\n${runRes.stdout}`);
  }
  const parsed = JSON.parse(payloadLine) as { __crashlyticsProbeResult: true; data: T };
  return { fixture, result: parsed.data };
}
