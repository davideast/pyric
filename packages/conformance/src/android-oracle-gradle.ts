/**
 * Gradle invocation and JUnit XML failure diagnostics for the Android
 * Robolectric oracle rig (`packages/conformance/rigs/native-android-oracle`).
 *
 * Keeps all Gradle caches, Kotlin persistent state, and build outputs under
 * `~/.cache/pyric-android-oracle` so the git working tree remains clean.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const GRADLEW_PATH = join(REPO_ROOT, 'packages', 'kt-client', 'gradlew');
const ANDROID_RIG_DIR = join(HERE, '..', 'rigs', 'native-android-oracle');

export interface AndroidGradleRunRequest {
  testFilter: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export type AndroidGradleExecutor = (request: AndroidGradleRunRequest) => void;

function findAndroidSdkHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (typeof env.ANDROID_HOME === 'string' && env.ANDROID_HOME.trim() !== '') {
    candidates.push(env.ANDROID_HOME.trim());
  }
  if (typeof env.ANDROID_SDK_ROOT === 'string' && env.ANDROID_SDK_ROOT.trim() !== '') {
    candidates.push(env.ANDROID_SDK_ROOT.trim());
  }
  candidates.push(join(homedir(), 'Android', 'Sdk'));
  candidates.push('/usr/local/lib/android/sdk');

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'platforms'))) {
      return candidate;
    }
  }
  return undefined;
}

function findGradleJavaHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (typeof env.JAVA_HOME === 'string' && env.JAVA_HOME.trim() !== '') {
    candidates.push(env.JAVA_HOME.trim());
  }
  candidates.push('/usr/lib/jvm/java-21-openjdk-amd64');
  candidates.push('/usr/lib/jvm/java-25-openjdk-amd64');

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'bin', 'java'))) {
      return candidate;
    }
  }
  return undefined;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function formatAndroidGradleFailureDiagnostics(
  gradleBuildDir: string,
  stdoutText: string,
  stderrText: string,
): string {
  const sections: string[] = [];
  const resultsDir = join(gradleBuildDir, 'test-results', 'testDebugUnitTest');
  if (existsSync(resultsDir)) {
    const entries = readdirSync(resultsDir).sort();
    for (const entry of entries) {
      if (!entry.startsWith('TEST-') || !entry.endsWith('.xml')) {
        continue;
      }
      const xml = readFileSync(join(resultsDir, entry), 'utf8');
      const failureRegex = /<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/g;
      let match = failureRegex.exec(xml);
      while (match !== null) {
        const body = match[1];
        if (typeof body === 'string' && body.trim() !== '') {
          sections.push(`[JUnit ${entry}]\n${decodeXmlEntities(body.trim())}`);
        }
        match = failureRegex.exec(xml);
      }
    }
  }

  const combined = `${stdoutText}\n${stderrText}`.trim();
  if (combined !== '') {
    const nonInternalLines = combined
      .split('\n')
      .filter((line) => !/^\s+at org\.gradle\./.test(line));
    const excerpt = nonInternalLines.slice(-120).join('\n');
    sections.push(`[Gradle output tail]\n${excerpt}`);
  }
  return sections.join('\n\n');
}

export function runAndroidOracleGradleTest(request: AndroidGradleRunRequest): void {
  let baseEnv: NodeJS.ProcessEnv = process.env;
  if (request.env !== undefined) {
    baseEnv = request.env;
  }
  const sdkHome = findAndroidSdkHome(baseEnv);
  if (!sdkHome) {
    throw new Error(
      'Missing Android SDK Platform 35: set ANDROID_HOME or ANDROID_SDK_ROOT before running android-sdk-probes.',
    );
  }
  const cacheRoot = join(homedir(), '.cache', 'pyric-android-oracle');
  const gradleCacheDir = join(cacheRoot, 'gradle-cache');
  const gradleBuildDir = join(cacheRoot, 'build');
  const kotlinPersistentDir = join(cacheRoot, 'kotlin-persistent');
  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ANDROID_HOME: sdkHome,
    ANDROID_SDK_ROOT: sdkHome,
    PYRIC_ANDROID_ORACLE_BUILD_DIR: gradleBuildDir,
  };
  const javaHome = findGradleJavaHome(baseEnv);
  if (javaHome) {
    childEnv.JAVA_HOME = javaHome;
  }

  const args: string[] = [
    '-p',
    ANDROID_RIG_DIR,
    '--project-cache-dir',
    gradleCacheDir,
    `-Dpyric.android.oracle.buildDir=${gradleBuildDir}`,
    `-Pkotlin.project.persistent.dir=${kotlinPersistentDir}`,
  ];
  if (typeof request.configPath === 'string' && request.configPath !== '') {
    args.push(`-Dpyric.android.oracle.configPath=${request.configPath}`);
  }
  args.push(':testDebugUnitTest', '--tests', request.testFilter, '--no-daemon');

  const result = spawnSync(GRADLEW_PATH, args, {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    let stdoutText = '';
    if (typeof result.stdout === 'string') {
      stdoutText = result.stdout;
    }
    let stderrText = '';
    if (typeof result.stderr === 'string') {
      stderrText = result.stderr;
    }
    const details = formatAndroidGradleFailureDiagnostics(gradleBuildDir, stdoutText, stderrText);
    throw new Error(
      `Android Robolectric runner exited with status ${String(result.status)}:\n${details}`,
    );
  }
}
