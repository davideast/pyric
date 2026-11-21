/**
 * Live-project Firebase session lifecycle for modular iOS / macOS upstream SDK
 * oracle probes (`packages/conformance/probes/{auth-swift,rtdb-swift,firestore-swift}/<name>.ts`).
 *
 * Keeps heavy `firebase-admin/*` imports lazy inside `runIosOracleProbe` so
 * `loadModularProbes` and inert previews stay sub-100ms and read zero ambient
 * credentials. Stages Swift package sources into isolated private job temp
 * directories (`createPrivateJobTmpDir`) so SwiftPM / Xcode never write
 * `Package.resolved`, `.build/`, or `DerivedData/` into the git working tree.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../../../scripts/lib/private-job-tmpdir.ts';
import {
  assertValidIosOracleAppName,
  defaultExecuteAuthSim,
  defaultExecuteFirestoreSim,
  defaultExecuteRtdbCli,
  defaultQueryAvailableSimulatorsJson,
  extractIosOracleCleanupUids,
  extractIosOracleResultFromOutput,
  normalizeIosOracleGoogleAppId,
  selectAvailableIosSimulatorDestination,
  stageIosPackageTemplate,
  type IosAuthSimRequest,
  type IosFirestoreSimRequest,
  type IosRtdbCliRequest,
} from './ios-oracle-simulator.ts';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken, oracleAppOptions, type OracleServiceAccount } from './oracle-credential.ts';
import { OracleRulesSession, firestoreOracleTarget, rtdbOracleTarget, runWithOracleRulesRestored, type OracleRulesTarget } from './oracle-rules-session.ts';
import { assertDedicatedOracleRtdbUrl, type OracleWebConfig } from './oracle-run-setup.ts';
import { installOracleSignalRestoreGuard } from './oracle-signal-restore.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const IOS_RIG_ROOT = join(HERE, '..', 'rigs', 'native-ios-oracle');
const RTDB_CLI_TEMPLATE_DIR = join(IOS_RIG_ROOT, 'rtdb-cli');
const AUTH_SIM_TEMPLATE_DIR = join(IOS_RIG_ROOT, 'auth-sim');
const FIRESTORE_SIM_TEMPLATE_DIR = join(IOS_RIG_ROOT, 'firestore-sim');
const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FALLBACK_GCM_SENDER_ID = '000000000000';

type IosOracleExecutionMode = 'macos-rtdb-cli' | 'ios-sim-auth' | 'ios-sim-firestore';

export interface IosAdminAuthAdapter {
  createCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
  deleteUser(uid: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface IosRtdbSessionOptions {
  rules: Record<string, unknown>;
  stripTopLevelGrants: boolean;
}

export interface IosFirestoreSessionOptions {
  collectionGroupId?: string;
}

interface IosProbeRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  loadServiceAccount?: (env?: NodeJS.ProcessEnv) => Promise<OracleServiceAccount>;
  resolveWebConfig?: (
    sa: OracleServiceAccount,
    env: Record<string, string | undefined>,
  ) => Promise<OracleWebConfig>;
  openAdminAuth?: (sa: OracleServiceAccount, runId: string) => Promise<IosAdminAuthAdapter>;
  deployScopedRtdbSession?: <T>(
    sa: OracleServiceAccount,
    databaseUrl: string,
    runId: string,
    fn: () => Promise<T>,
    options?: IosRtdbSessionOptions,
  ) => Promise<T>;
  deployScopedFirestoreSession?: <T>(
    sa: OracleServiceAccount,
    runId: string,
    fn: () => Promise<T>,
    options?: IosFirestoreSessionOptions,
  ) => Promise<T>;
  queryAvailableSimulatorsJson?: (env: NodeJS.ProcessEnv) => string;
  executeRtdbCli?: (request: IosRtdbCliRequest) => string;
  executeAuthSim?: (request: IosAuthSimRequest) => string;
  executeFirestoreSim?: (request: IosFirestoreSimRequest) => string;
}

export interface RunIosOracleProbeOptions {
  probeId: string;
  mode: IosOracleExecutionMode;
  rtdbRunRules?: Record<string, unknown>;
  needsCollectionGroupRule?: boolean;
  needsCustomToken?: boolean;
  deps?: IosProbeRuntimeDeps;
}

function nextIosRunId(): string {
  return `ios_${randomUUID().replaceAll('-', '')}`;
}

export function buildIosRtdbRunRules(): Record<string, unknown> {
  return { '.read': true, '.write': true, items: { '.indexOn': ['score'] } };
}

export function buildIosRtdbNavigationAndChildQueryRules(): Record<string, unknown> {
  return { '.read': true, '.write': true, players: { '.indexOn': ['score', 'tier'] } };
}

export function buildIosRtdbPermissionAndQueryRules(): Record<string, unknown> {
  return {
    workspace: { '.read': true, '.write': true, scores: { '.indexOn': '.value' } },
    denied_leaf: { '.read': false, '.write': false },
  };
}

async function defaultOpenAdminAuth(
  sa: OracleServiceAccount,
  runId: string,
): Promise<IosAdminAuthAdapter> {
  const [adminAppMod, { getAuth }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
  ]);
  const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `ios-oracle-admin-${runId}`);
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
  sessionOptions?: IosRtdbSessionOptions,
): Promise<T> {
  let sessionRules = buildIosRtdbRunRules();
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
  const detachSignals = installOracleSignalRestoreGuard('[ios-sdk-probes]', () =>
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
          // Best-effort secondary cleanup after RtdbOracleCLI's own removeValue().
        }
      }
    });
  } finally {
    detachSignals();
    if (session.restoredRtdb) {
      console.log('[ios-sdk-probes] RTDB rules restored and verified');
    }
  }
}

export function buildIosFirestoreRulesTarget(collectionGroupId?: string): OracleRulesTarget {
  if (collectionGroupId === undefined) {
    return firestoreOracleTarget();
  }
  if (!/^cg_[A-Za-z0-9_]+$/.test(collectionGroupId)) {
    throw new Error(`Invalid Firestore oracle collectionGroupId: '${collectionGroupId}'`);
  }
  const marker = `@pyric/oracle/cg:${collectionGroupId}`;
  const block = [
    `      // ${marker} - scoped pyric_oracle/* and collectionGroup rule`,
    '      match /pyric_oracle/{run}/{anything=**} {',
    '        allow read, write: if request.auth != null;',
    '      }',
    `      match /{path=**}/${collectionGroupId}/{docId} {`,
    '        allow read, write: if request.auth != null;',
    '      }',
  ].join('\n');
  return {
    service: 'Firestore',
    release: 'cloud.firestore',
    rulesFileName: 'firestore.rules',
    marker,
    freshRules: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n  }\n}\n`,
    insertAfter: /(match\s+\/databases\/\{database\}\/documents\s*\{)/,
    insertAfterDescription: '`match /databases/{database}/documents`',
    block: `\n${block}\n`,
  };
}

async function defaultDeployScopedFirestoreSession<T>(
  sa: OracleServiceAccount,
  runId: string,
  fn: () => Promise<T>,
  sessionOptions?: IosFirestoreSessionOptions,
): Promise<T> {
  const [adminAppMod, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/firestore'),
  ]);
  const session = new OracleRulesSession({
    projectId: sa.project_id,
    accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
  });
  const detachSignals = installOracleSignalRestoreGuard('[ios-sdk-probes]', () =>
    session.restoreAll(),
  );
  const adminApp = adminAppMod.initializeApp(
    oracleAppOptions(sa),
    `ios-oracle-fs-admin-${runId}`,
  );
  const adminDb = getFirestore(adminApp);
  let cgId: string | undefined;
  if (sessionOptions !== undefined) {
    cgId = sessionOptions.collectionGroupId;
  }

  try {
    return await runWithOracleRulesRestored(session, async () => {
      const outcome = await session.deploy(buildIosFirestoreRulesTarget(cgId));
      if (outcome !== 'already-configured') {
        await new Promise((resolveDone) => setTimeout(resolveDone, 10_000));
      }
      try {
        return await fn();
      } finally {
        await adminDb.recursiveDelete(adminDb.doc(`pyric_oracle/${runId}`)).catch(() => undefined);
      }
    });
  } finally {
    await adminAppMod.deleteApp(adminApp).catch(() => undefined);
    detachSignals();
    if (session.restoredFirestoreOrStorage) {
      console.log('[ios-sdk-probes] Firestore rules restored and verified');
    }
  }
}

function recordFailedSimOutputUids(simErr: unknown, trackedUids: Set<string>): void {
  let failedOutput = '';
  if (typeof simErr === 'object' && simErr !== null && 'output' in simErr) {
    const attached = (simErr as { output?: unknown }).output;
    if (typeof attached === 'string') {
      failedOutput = attached;
    }
  }
  if (failedOutput === '' && simErr instanceof Error) {
    failedOutput = simErr.message;
  }
  for (const uid of extractIosOracleCleanupUids(failedOutput)) {
    trackedUids.add(uid);
  }
}

function parseSimOutputAndCollectUids(
  simOutput: string,
  trackedUids: Set<string>,
): Record<string, unknown> {
  for (const uid of extractIosOracleCleanupUids(simOutput)) {
    trackedUids.add(uid);
  }
  const rawBehavior = extractIosOracleResultFromOutput(simOutput);
  const cleanupList = rawBehavior._cleanupUids;
  if (Array.isArray(cleanupList)) {
    for (const entry of cleanupList) {
      if (typeof entry === 'string' && entry.trim() !== '') {
        trackedUids.add(entry.trim());
      }
    }
  }
  delete rawBehavior._cleanupUids;
  return rawBehavior;
}

export async function runIosOracleProbe(
  options: RunIosOracleProbeOptions,
): Promise<Record<string, unknown>> {
  let deps: IosProbeRuntimeDeps = {};
  if (options.deps !== undefined) {
    deps = options.deps;
  }
  let env: NodeJS.ProcessEnv = process.env;
  if (deps.env !== undefined) {
    env = deps.env;
  }
  let platform: NodeJS.Platform = process.platform;
  if (deps.platform !== undefined) {
    platform = deps.platform;
  }
  if (platform !== 'darwin') {
    throw new Error(
      `ios-sdk-probes requires macOS (darwin) with SwiftPM and Xcode iOS Simulator; current platform is '${platform}'.`,
    );
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

  let gcmSenderId = FALLBACK_GCM_SENDER_ID;
  if (typeof webConfig.messagingSenderId === 'string' && webConfig.messagingSenderId.trim() !== '') {
    gcmSenderId = webConfig.messagingSenderId.trim();
  }
  const googleAppId = normalizeIosOracleGoogleAppId(webConfig.appId, gcmSenderId);

  const runId = assertValidIosOracleAppName(nextIosRunId());
  const jobTmpDir = createPrivateJobTmpDir('ios-oracle', env);
  const sharedCacheRoot = join(homedir(), '.cache', 'pyric-ios-oracle-spm');

  try {
    if (options.mode === 'macos-rtdb-cli') {
      let rawRtdbUrl = webConfig.databaseURL;
      if (typeof env.PYRIC_ORACLE_RTDB_URL === 'string' && env.PYRIC_ORACLE_RTDB_URL.trim() !== '') {
        rawRtdbUrl = env.PYRIC_ORACLE_RTDB_URL.trim();
      }
      const databaseUrl = assertDedicatedOracleRtdbUrl(rawRtdbUrl, sa.project_id);

      const stagedDir = join(jobTmpDir, 'rtdb-cli');
      stageIosPackageTemplate(RTDB_CLI_TEMPLATE_DIR, stagedDir);
      const inputPath = join(jobTmpDir, 'rtdb-input.json');
      const outputPath = join(jobTmpDir, 'rtdb-output.json');
      writeFileSync(
        inputPath,
        `${JSON.stringify(
          {
            probeId: options.probeId,
            runId,
            projectId: sa.project_id,
            googleAppId,
            gcmSenderId,
            apiKey: webConfig.apiKey,
            databaseUrl,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      let runRtdbSession = defaultDeployScopedRtdbSession;
      if (deps.deployScopedRtdbSession !== undefined) {
        runRtdbSession = deps.deployScopedRtdbSession;
      }
      let executeRtdbCli = defaultExecuteRtdbCli;
      if (deps.executeRtdbCli !== undefined) {
        executeRtdbCli = deps.executeRtdbCli;
      }

      let desiredRtdbRules = buildIosRtdbRunRules();
      let stripTopLevelGrants = false;
      if (options.rtdbRunRules !== undefined) {
        desiredRtdbRules = options.rtdbRunRules;
        stripTopLevelGrants = true;
      }

      const cliOutput = await runRtdbSession(
        sa,
        databaseUrl,
        runId,
        async () =>
          executeRtdbCli({
            stagedPackageDir: stagedDir,
            scratchCacheDir: join(sharedCacheRoot, 'rtdb-cli-build'),
            inputPath,
            outputPath,
            env,
          }),
        {
          rules: desiredRtdbRules,
          stripTopLevelGrants,
        },
      );

      if (existsSync(outputPath)) {
        return JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
      }
      return extractIosOracleResultFromOutput(cliOutput);
    }

    let openAdmin = defaultOpenAdminAuth;
    if (deps.openAdminAuth !== undefined) {
      openAdmin = deps.openAdminAuth;
    }
    const adminAuth = await openAdmin(sa, runId);
    const trackedUids = new Set<string>();
    let needsCustomToken = true;
    if (options.needsCustomToken !== undefined) {
      needsCustomToken = options.needsCustomToken;
    }
    let expectedCustomUid = '';
    if (needsCustomToken) {
      expectedCustomUid = `pyric-ios-${runId}`;
      trackedUids.add(expectedCustomUid);
    }

    try {
      let customToken = '';
      if (needsCustomToken) {
        customToken = await adminAuth.createCustomToken(expectedCustomUid, {
          role: 'tester',
          tier: 2,
        });
      }

      let querySimulators = defaultQueryAvailableSimulatorsJson;
      if (deps.queryAvailableSimulatorsJson !== undefined) {
        querySimulators = deps.queryAvailableSimulatorsJson;
      }
      const simSelection = selectAvailableIosSimulatorDestination(querySimulators(env));

      const simInputJson = `${JSON.stringify(
        {
          mode: 'live',
          probeId: options.probeId,
          runId,
          projectId: sa.project_id,
          googleAppId,
          gcmSenderId,
          apiKey: webConfig.apiKey,
          customToken,
          expectedCustomUid,
        },
        null,
        2,
      )}\n`;

      if (options.mode === 'ios-sim-firestore') {
        const stagedDir = join(jobTmpDir, 'firestore-sim');
        stageIosPackageTemplate(FIRESTORE_SIM_TEMPLATE_DIR, stagedDir);
        const bundledInputPath = join(
          stagedDir,
          'Tests',
          'FirestoreOracleSimTests',
          'Resources',
          'oracle-input.json',
        );
        writeFileSync(bundledInputPath, simInputJson, 'utf8');

        let runFirestoreSession = defaultDeployScopedFirestoreSession;
        if (deps.deployScopedFirestoreSession !== undefined) {
          runFirestoreSession = deps.deployScopedFirestoreSession;
        }
        let executeFirestoreSim = defaultExecuteFirestoreSim;
        if (deps.executeFirestoreSim !== undefined) {
          executeFirestoreSim = deps.executeFirestoreSim;
        }
        let fsSessionOpts: IosFirestoreSessionOptions | undefined;
        if (options.needsCollectionGroupRule === true) {
          fsSessionOpts = { collectionGroupId: `cg_${runId}` };
        }

        const simOutput = await runFirestoreSession(
          sa,
          runId,
          async () => {
            try {
              return executeFirestoreSim({
                stagedPackageDir: stagedDir,
                derivedDataDir: join(sharedCacheRoot, 'xcode-firestore-derived-data'),
                clonedPackagesDir: join(sharedCacheRoot, 'xcode-source-packages'),
                destination: simSelection.destination,
                env,
              });
            } catch (simErr) {
              recordFailedSimOutputUids(simErr, trackedUids);
              throw simErr;
            }
          },
          fsSessionOpts,
        );
        return parseSimOutputAndCollectUids(simOutput, trackedUids);
      }

      const stagedDir = join(jobTmpDir, 'auth-sim');
      stageIosPackageTemplate(AUTH_SIM_TEMPLATE_DIR, stagedDir);
      const bundledInputPath = join(
        stagedDir,
        'Tests',
        'AuthOracleSimTests',
        'Resources',
        'oracle-input.json',
      );
      writeFileSync(bundledInputPath, simInputJson, 'utf8');

      let executeAuthSim = defaultExecuteAuthSim;
      if (deps.executeAuthSim !== undefined) {
        executeAuthSim = deps.executeAuthSim;
      }
      let simOutput = '';
      try {
        simOutput = executeAuthSim({
          stagedPackageDir: stagedDir,
          derivedDataDir: join(sharedCacheRoot, 'xcode-derived-data'),
          clonedPackagesDir: join(sharedCacheRoot, 'xcode-source-packages'),
          destination: simSelection.destination,
          env,
        });
      } catch (simErr) {
        recordFailedSimOutputUids(simErr, trackedUids);
        throw simErr;
      }

      return parseSimOutputAndCollectUids(simOutput, trackedUids);
    } finally {
      for (const uid of trackedUids) {
        try {
          await adminAuth.deleteUser(uid);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code !== 'auth/user-not-found') {
            console.error(
              `[ios-sdk-probes] warning: failed to delete test user ${uid}: ${String(err)}`,
            );
          }
        }
      }
      await adminAuth.dispose();
    }
  } finally {
    removePrivateJobTmpDir(jobTmpDir, env);
  }
}
