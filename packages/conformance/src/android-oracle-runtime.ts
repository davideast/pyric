/**
 * Live-project Robolectric execution helper for modular Android oracle probes
 * (`packages/conformance/probes/{auth-kotlin,rtdb-kotlin}/<name>.ts`).
 *
 * Heavy `firebase-admin/*` imports stay lazy inside `runAndroidRobolectricProbe`
 * so `loadModularProbes` and inert previews remain fast and read zero ambient
 * credentials. All Gradle caches, build outputs, and per-run probe config/output
 * files stay under `~/.cache/pyric-android-oracle` and `createPrivateJobTmpDir`
 * so the git working tree remains clean for `oracle-observation-diff.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../scripts/lib/private-job-tmpdir.ts';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  type OracleServiceAccount,
} from './oracle-credential.ts';
import {
  OracleRulesSession,
  rtdbOracleTarget,
  runWithOracleRulesRestored,
} from './oracle-rules-session.ts';
import {
  assertDedicatedOracleRtdbUrl,
  type OracleWebConfig,
} from './oracle-run-setup.ts';
import { installOracleSignalRestoreGuard } from './oracle-signal-restore.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const GRADLEW_PATH = join(REPO_ROOT, 'packages', 'kt-client', 'gradlew');
const ANDROID_RIG_DIR = join(HERE, '..', 'rigs', 'native-android-oracle');
const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FALLBACK_ANDROID_APP_ID = '1:000000000000:android:pyricoracle';

export interface AndroidOracleProbeConfigPayload {
  probeId: string;
  runId: string;
  projectId: string;
  applicationId: string;
  apiKey: string;
  customToken?: string;
  databaseUrl?: string;
  outputPath: string;
  cleanupUidsPath: string;
}

interface AndroidGradleRunRequest {
  testFilter: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

type AndroidGradleExecutor = (request: AndroidGradleRunRequest) => void;

export interface AndroidAdminAuthAdapter {
  createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
  deleteUser(uid: string): Promise<void>;
  dispose(): Promise<void>;
}

interface AndroidProbeRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  loadServiceAccount?: (env?: NodeJS.ProcessEnv) => Promise<OracleServiceAccount>;
  resolveWebConfig?: (
    sa: OracleServiceAccount,
    env: Record<string, string | undefined>,
  ) => Promise<OracleWebConfig>;
  openAdminAuth?: (sa: OracleServiceAccount, runId: string) => Promise<AndroidAdminAuthAdapter>;
  deployScopedRtdbSession?: <T>(
    sa: OracleServiceAccount,
    databaseUrl: string,
    runId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  executeGradle?: AndroidGradleExecutor;
}

interface RunAndroidRobolectricProbeOptions {
  probeId: string;
  needsDedicatedRtdb?: boolean;
  needsCustomToken?: boolean;
  deps?: AndroidProbeRuntimeDeps;
}

function nextAndroidRunId(): string {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `android_${stamp}_${nonce}`;
}

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

async function defaultOpenAdminAuth(
  sa: OracleServiceAccount,
  runId: string,
): Promise<AndroidAdminAuthAdapter> {
  const [adminAppMod, { getAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
  ]);
  const adminApp = adminAppMod.initializeApp(
    oracleAppOptions(sa),
    `android-oracle-admin-${runId}`,
  );
  const adminAuth = getAuth(adminApp);
  return {
    createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string> {
      return adminAuth.createCustomToken(uid, developerClaims);
    },
    deleteUser(uid: string): Promise<void> {
      return adminAuth.deleteUser(uid);
    },
    async dispose(): Promise<void> {
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
    },
  };
}

async function defaultDeployScopedRtdbSession<T>(
  sa: OracleServiceAccount,
  databaseUrl: string,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const getRtdbToken = () => oracleAccessToken(sa, RTDB_RULES_SCOPE);
  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[android-sdk-probes]', () =>
    session.restoreAll(),
  );
  try {
    return await runWithOracleRulesRestored(session, async () => {
      await session.deployRtdb(
        rtdbOracleTarget(databaseUrl, getRtdbToken, {
          runId,
          rules: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            rtdb_kotlin: {
              catalog: { '.indexOn': ['score'] },
            },
          },
          stripTopLevelGrants: false,
        }),
      );
      await new Promise((resolveDone) => setTimeout(resolveDone, 5_000));
      try {
        return await fn();
      } finally {
        try {
          const token = await getRtdbToken();
          const deleteUrl = `${databaseUrl}/pyric_oracle/${runId}.json?access_token=${encodeURIComponent(token)}&print=silent`;
          await fetch(deleteUrl, { method: 'DELETE' });
        } catch {
          // Best-effort secondary cleanup after Kotlin runner's own removeValue().
        }
      }
    });
  } finally {
    detachSignals();
    if (session.restoredRtdb) {
      console.log('[android-sdk-probes] RTDB rules restored and verified');
    }
  }
}

function collectSidecarCleanupUids(cleanupUidsPath: string, trackedUids: Set<string>): void {
  if (!existsSync(cleanupUidsPath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(cleanupUidsPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string' && item.trim() !== '') {
          trackedUids.add(item.trim());
        }
      }
    }
  } catch {
    // Ignore malformed sidecar so remaining trackedUids still get deleted.
  }
}

export async function runAndroidRobolectricProbe(
  options: RunAndroidRobolectricProbeOptions,
): Promise<Record<string, unknown>> {
  let deps: AndroidProbeRuntimeDeps = {};
  if (options.deps !== undefined) {
    deps = options.deps;
  }
  let env: NodeJS.ProcessEnv = process.env;
  if (deps.env !== undefined) {
    env = deps.env;
  }

  let loadSa = loadOracleServiceAccount;
  if (deps.loadServiceAccount !== undefined) {
    loadSa = deps.loadServiceAccount;
  }
  const sa = await loadSa(env);

  let resolveConfig = (
    account: OracleServiceAccount,
    envMap: Record<string, string | undefined>,
  ) => resolveProbeWebConfig(account, { env: envMap });
  if (deps.resolveWebConfig !== undefined) {
    resolveConfig = deps.resolveWebConfig;
  }
  const webConfig = await resolveConfig(sa, env as Record<string, string | undefined>);

  let databaseUrl: string | undefined;
  if (options.needsDedicatedRtdb) {
    let rawRtdbUrl = webConfig.databaseURL;
    if (typeof env.PYRIC_ORACLE_RTDB_URL === 'string' && env.PYRIC_ORACLE_RTDB_URL.trim() !== '') {
      rawRtdbUrl = env.PYRIC_ORACLE_RTDB_URL.trim();
    }
    databaseUrl = assertDedicatedOracleRtdbUrl(rawRtdbUrl, sa.project_id);
  }

  const runId = nextAndroidRunId();
  let openAdmin = defaultOpenAdminAuth;
  if (deps.openAdminAuth !== undefined) {
    openAdmin = deps.openAdminAuth;
  }
  const adminAuth = await openAdmin(sa, runId);

  const trackedUids = new Set<string>();
  const shouldMintCustomToken = options.needsCustomToken !== false;
  const customUid = `pyric-android-${runId}`;
  if (shouldMintCustomToken) {
    trackedUids.add(customUid);
  }

  const scratchDir = createPrivateJobTmpDir('android-rig', env);
  const configPath = join(scratchDir, 'probe-config.json');
  const outputPath = join(scratchDir, 'probe-output.json');
  const cleanupUidsPath = join(scratchDir, 'cleanup-uids.json');

  let executeGradle: AndroidGradleExecutor = runAndroidOracleGradleTest;
  if (deps.executeGradle !== undefined) {
    executeGradle = deps.executeGradle;
  }
  let runRtdbSession = defaultDeployScopedRtdbSession;
  if (deps.deployScopedRtdbSession !== undefined) {
    runRtdbSession = deps.deployScopedRtdbSession;
  }

  try {
    let customToken: string | undefined;
    if (shouldMintCustomToken) {
      customToken = await adminAuth.createCustomToken(customUid, {
        role: 'tester',
        tier: 2,
      });
    }
    let applicationId = FALLBACK_ANDROID_APP_ID;
    if (typeof webConfig.appId === 'string' && webConfig.appId.trim() !== '') {
      applicationId = webConfig.appId.trim();
    }

    const payload: AndroidOracleProbeConfigPayload = {
      probeId: options.probeId,
      runId,
      projectId: sa.project_id,
      applicationId,
      apiKey: webConfig.apiKey,
      outputPath,
      cleanupUidsPath,
    };
    if (customToken !== undefined) {
      payload.customToken = customToken;
    }
    if (databaseUrl !== undefined) {
      payload.databaseUrl = databaseUrl;
    }
    writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const invokeRunner = async (): Promise<void> => {
      executeGradle({
        testFilter:
          'dev.pyric.conformance.androidoracle.AndroidOracleProbeRunnerTest.captureSelectedOracleProbe',
        configPath,
        env,
      });
    };

    if (databaseUrl !== undefined) {
      await runRtdbSession(sa, databaseUrl, runId, invokeRunner);
    } else {
      await invokeRunner();
    }

    if (!existsSync(outputPath)) {
      throw new Error(
        `Android Robolectric probe '${options.probeId}' finished without writing ${outputPath}`,
      );
    }
    const rawBehavior = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    const cleanupList = rawBehavior._cleanupUids;
    if (Array.isArray(cleanupList)) {
      for (const item of cleanupList) {
        if (typeof item === 'string' && item.trim() !== '') {
          trackedUids.add(item.trim());
        }
      }
    }
    delete rawBehavior._cleanupUids;
    return rawBehavior;
  } finally {
    collectSidecarCleanupUids(cleanupUidsPath, trackedUids);
    for (const uid of trackedUids) {
      try {
        await adminAuth.deleteUser(uid);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== 'auth/user-not-found') {
          console.error(
            `[android-sdk-probes] warning: failed to delete test user ${uid}: ${String(err)}`,
          );
        }
      }
    }
    await adminAuth.dispose();
    removePrivateJobTmpDir(scratchDir, env);
  }
}
