/**
 * Live-project Robolectric execution helper for modular Android oracle probes
 * (`packages/conformance/probes/{auth-kotlin,rtdb-kotlin,firestore-kotlin}/<name>.ts`).
 *
 * Heavy `firebase-admin/*` imports stay lazy inside `runAndroidRobolectricProbe`
 * so `loadModularProbes` and inert previews remain fast and read zero ambient
 * credentials. All Gradle caches, build outputs, and per-run probe config/output
 * files stay under `~/.cache/pyric-android-oracle` and `createPrivateJobTmpDir`
 * so the git working tree remains clean for `oracle-observation-diff.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../scripts/lib/private-job-tmpdir.ts';
import {
  formatAndroidGradleFailureDiagnostics,
  runAndroidOracleGradleTest,
  type AndroidGradleExecutor,
} from './android-oracle-gradle.ts';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  type OracleServiceAccount,
} from './oracle-credential.ts';
import {
  OracleRulesSession,
  firestoreOracleTarget,
  rtdbOracleTarget,
  runWithOracleRulesRestored,
} from './oracle-rules-session.ts';
import {
  assertDedicatedOracleRtdbUrl,
  type OracleWebConfig,
} from './oracle-run-setup.ts';
import { installOracleSignalRestoreGuard } from './oracle-signal-restore.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';

export { formatAndroidGradleFailureDiagnostics, runAndroidOracleGradleTest };

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

export interface AndroidAdminAuthAdapter {
  createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
  deleteUser(uid: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AndroidRtdbSessionOptions {
  rules: Record<string, unknown>;
  stripTopLevelGrants: boolean;
}

export interface AndroidFirestoreSessionOptions {
  collectionGroupId?: string;
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
    options?: AndroidRtdbSessionOptions,
  ) => Promise<T>;
  deployScopedFirestoreSession?: <T>(
    sa: OracleServiceAccount,
    runId: string,
    fn: () => Promise<T>,
    options?: AndroidFirestoreSessionOptions,
  ) => Promise<T>;
  executeGradle?: AndroidGradleExecutor;
}

interface RunAndroidRobolectricProbeOptions {
  probeId: string;
  needsDedicatedRtdb?: boolean;
  rtdbRunRules?: Record<string, unknown>;
  needsFirestore?: boolean;
  needsFirestoreCollectionGroup?: boolean;
  needsCustomToken?: boolean;
  deps?: AndroidProbeRuntimeDeps;
}

const DEFAULT_ANDROID_RTDB_RUN_RULES: Record<string, unknown> = {
  '.read': 'auth != null',
  '.write': 'auth != null',
  rtdb_kotlin: {
    catalog: { '.indexOn': ['score'] },
  },
};

export function buildAndroidRtdbPermissionAndQueryRules(): Record<string, unknown> {
  return {
    rtdb_kotlin: {
      '.read': 'auth != null',
      '.write': 'auth != null',
      scores: { '.indexOn': '.value' },
      players: { '.indexOn': ['score', 'tier'] },
    },
    denied_zone: {
      '.read': false,
      '.write': false,
    },
  };
}

function nextAndroidRunId(): string {
  const stamp = Date.now().toString(36);
  const nonce = Math.random().toString(36).slice(2, 8);
  return `android_${stamp}_${nonce}`;
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
  sessionOptions?: AndroidRtdbSessionOptions,
): Promise<T> {
  let sessionRules = DEFAULT_ANDROID_RTDB_RUN_RULES;
  let stripTopLevelGrants = false;
  if (sessionOptions !== undefined) {
    sessionRules = sessionOptions.rules;
    stripTopLevelGrants = sessionOptions.stripTopLevelGrants;
  }
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
          rules: sessionRules,
          stripTopLevelGrants,
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

async function defaultDeployScopedFirestoreSession<T>(
  sa: OracleServiceAccount,
  runId: string,
  fn: () => Promise<T>,
  firestoreOptions?: AndroidFirestoreSessionOptions,
): Promise<T> {
  const [adminAppMod, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[android-sdk-probes]', () =>
    session.restoreAll(),
  );
  const adminApp = adminAppMod.initializeApp(
    oracleAppOptions(sa),
    `android-oracle-fs-admin-${runId}`,
  );
  const adminDb = getFirestore(adminApp);

  try {
    return await runWithOracleRulesRestored(session, async () => {
      const outcome = await session.deploy(firestoreOracleTarget(firestoreOptions));
      if (outcome !== 'already-configured') {
        await new Promise((resolveDone) => setTimeout(resolveDone, 10_000));
      }
      try {
        return await fn();
      } finally {
        await adminDb.recursiveDelete(adminDb.doc(`pyric_oracle/${runId}`)).catch(() => undefined);
        if (firestoreOptions !== undefined && firestoreOptions.collectionGroupId !== undefined) {
          await adminDb
            .recursiveDelete(adminDb.collection(firestoreOptions.collectionGroupId))
            .catch(() => undefined);
        }
      }
    });
  } finally {
    await adminAppMod.deleteApp(adminApp).catch(() => undefined);
    detachSignals();
    if (session.restoredFirestoreOrStorage) {
      console.log('[android-sdk-probes] Firestore rules restored and verified');
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
  let runFirestoreSession = defaultDeployScopedFirestoreSession;
  if (deps.deployScopedFirestoreSession !== undefined) {
    runFirestoreSession = deps.deployScopedFirestoreSession;
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

    let rtdbSessionOptions: AndroidRtdbSessionOptions | undefined;
    if (options.rtdbRunRules !== undefined) {
      rtdbSessionOptions = {
        rules: options.rtdbRunRules,
        stripTopLevelGrants: true,
      };
    }

    let firestoreSessionOptions: AndroidFirestoreSessionOptions | undefined;
    if (options.needsFirestoreCollectionGroup === true) {
      firestoreSessionOptions = {
        collectionGroupId: `cg_${runId}`,
      };
    }

    if (databaseUrl !== undefined && options.needsFirestore === true) {
      await runRtdbSession(
        sa,
        databaseUrl,
        runId,
        () => runFirestoreSession(sa, runId, invokeRunner, firestoreSessionOptions),
        rtdbSessionOptions,
      );
    } else if (databaseUrl !== undefined) {
      await runRtdbSession(sa, databaseUrl, runId, invokeRunner, rtdbSessionOptions);
    } else if (options.needsFirestore === true) {
      await runFirestoreSession(sa, runId, invokeRunner, firestoreSessionOptions);
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
