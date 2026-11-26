#!/usr/bin/env bun
/**
 * RTDB rules oracle capture runner (`deploy -> observe -> restore + read-back`).
 *
 * Enforces two invariants before writing observations into `observations/rtdb-rules/`:
 *   1. RULES RESTORED: pre-run rules rewritten and read back (3-attempt retry,
 *      guarded against SIGINT/SIGTERM and in-flight PUT races).
 *   2. DATA & USERS REMOVED: `/pyric_oracle_rulesrtdb_<runId>` deleted and
 *      proven absent via shallow root read, and run-created Auth users deleted.
 *
 * Requires `--write` plus `PYRIC_ORACLE_FIREBASE_CONFIG` (or `PYRIC_ORACLE_RTDB_URL`
 * naming a dedicated non-default RTDB instance) and an oracle credential.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rtdbObservationName,
  type RtdbCaseIdentity,
  type RtdbTestCase,
} from '../rules-corpus/rtdb/index.ts';
import { requireCaptureMode } from './capture-mode-guard.ts';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
  oracleCredentialConfigured,
} from './oracle-credential.ts';
import { assertDedicatedOracleRtdbUrl } from './oracle-run-setup.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from './oracle-signal-restore.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import {
  runCapturePhases,
  type CapturedObservation,
} from './rtdb-rules-capture-run.ts';
import {
  createAdminUserStore,
  createRunUser,
  formatErrorMessage,
  mintCustomToken,
  runBestEffortTeardown,
  verifyRunDataCleanup,
  verifyRunUserCleanup,
  type RunDataStore,
  type RunUserCreator,
  type RunUserProps,
  type RunUserStore,
} from './rtdb-rules-cleanup.ts';
import { canonicalize } from './rtdb-rules-deploy.ts';
import { orderDeployScenarios, runDeployScenarios } from './rtdb-rules-deploy-run.ts';
import {
  createRefreshingAccessToken,
  createRtdbRulesRestClients,
  restoreBeforeLatePhaseWithRetry,
} from './rtdb-rules-endpoint-resilience.ts';
import {
  MULTI_INSTANCE_OBSERVATION,
  MULTI_INSTANCE_RULES,
  capturableRules,
  captureMultiInstance,
  captureMultiInstanceSdk,
  instanceRulesForCapture,
  verifyRulesTextRestored,
} from './rtdb-rules-multi-instance.ts';
import {
  assertMatchingOracleProjects,
  observationLinkageOf,
  printInertPlan,
  queryConstraintsOf,
  selectRtdbScenarios,
  substituteUid,
  type ObservationLinkage,
  type RtdbSelection,
} from './rtdb-rules-selection.ts';

export {
  MULTI_INSTANCE_OBSERVATION,
  MULTI_INSTANCE_RULES,
  assertMatchingOracleProjects,
  capturableRules,
  captureMultiInstanceSdk,
  createRunUser,
  instanceRulesForCapture,
  observationLinkageOf,
  queryConstraintsOf,
  selectRtdbScenarios,
  verifyRulesTextRestored,
  verifyRunDataCleanup,
  verifyRunUserCleanup,
  type RunDataStore,
  type RunUserCreator,
  type RunUserStore,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PREFIX = '[oracle:rules-rtdb]';
// rules-rtdb-* observations belong to the 'rtdb-rules' surface subdirectory
// (surfaces/rtdb-rules.json owns the prefix), NOT the SDK-plane 'rtdb' one.
const OBS_DIR = join(HERE, '..', 'observations', 'rtdb-rules');

interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  databaseURL?: string;
}

interface Observation {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  behavior: Record<string, unknown>;
}

function observationPath(scenario: { id: string }): string {
  return join(OBS_DIR, `${rtdbObservationName(scenario)}.json`);
}

/** Captures the selection and returns the exit code: non-zero when a scenario produced no observation. */
async function capture({ scenarios, deployScenarios }: RtdbSelection): Promise<number> {
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInAnonymously, signInWithCustomToken, signOut } = await import('firebase/auth');
  const {
    getDatabase,
    ref: rtdbRef,
    get: rtdbGet,
    set: rtdbSet,
    update: rtdbUpdate,
    query: rtdbQuery,
    orderByChild,
    orderByKey,
    orderByValue,
    orderByPriority,
    equalTo,
    startAt,
    endAt,
    limitToFirst,
    limitToLast,
  } = await import('firebase/database');
  const {
    initializeApp: adminInitializeApp,
    deleteApp: adminDeleteApp,
  } = await import('firebase-admin/app');
  const { getDatabaseWithUrl: getAdminDatabase } = await import('firebase-admin/database');
  const { getAuth: getAdminAuth } = await import('firebase-admin/auth');

  const rawConfigText = process.env.PYRIC_ORACLE_FIREBASE_CONFIG ?? '{}';
  const config = JSON.parse(rawConfigText) as FirebaseWebConfig;
  const serviceAccount = await loadOracleServiceAccount();
  assertMatchingOracleProjects(config, serviceAccount);
  config.databaseURL = assertDedicatedOracleRtdbUrl(
    process.env.PYRIC_ORACLE_RTDB_URL ?? config.databaseURL,
    config.projectId,
  );
  const databaseUrl = config.databaseURL;
  const fbSdkVersion = resolvedFirebaseVersion();

  console.log(`${LOG_PREFIX} project: ${config.projectId}`);
  console.log(`${LOG_PREFIX} database: ${databaseUrl}`);
  console.log(`${LOG_PREFIX} firebase ${fbSdkVersion}\n`);

  const coordinator = createSignalRestoreCoordinator(LOG_PREFIX);
  const uninstallSignals = coordinator.installSignals();
  const tokenProvider = createRefreshingAccessToken({
    mint: () => oracleAccessToken(serviceAccount, RTDB_RULES_SCOPE),
  });
  const { readRules, writeRules, endpoint, store } = createRtdbRulesRestClients({
    databaseUrl,
    tokenProvider,
    coordinator,
    parseRules: (source) => capturableRules('the database', source).rules,
    logPrefix: LOG_PREFIX,
  });

  const beforeRules = await readRules();
  const beforeCanonical = canonicalize(beforeRules);
  console.log(`${LOG_PREFIX} snapshotted pre-run rules.`);

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auditKey = `pyric_oracle_rulesrtdb_${runId}`;

  const app = initializeApp(config, `oracle-rules-rtdb-${runId}`);
  const auth = getAuth(app);
  const rtdb = getDatabase(app);
  const adminApp = adminInitializeApp(
    { ...oracleAppOptions(serviceAccount), databaseURL: databaseUrl },
    `oracle-rules-rtdb-admin-${runId}`,
  );
  const adminDb = getAdminDatabase(databaseUrl, adminApp);
  const adminAuth = getAdminAuth(adminApp);
  const claimsUid = `pyric-oracle-rulesrtdb-${runId}`;
  const runUids = new Set<string>([claimsUid]);
  const identityUids = new Map<string, string>();

  async function identityUser(identity: RtdbCaseIdentity): Promise<string> {
    const key = JSON.stringify(identity);
    const existing = identityUids.get(key);
    if (existing) {
      return existing;
    }
    const uid = `pyric-oracle-rulesrtdb-${runId}-${identityUids.size}`;
    identityUids.set(key, uid);
    const userProps: RunUserProps = { uid };
    if (identity.emailDomain) {
      userProps.email = `${uid}@${identity.emailDomain}`;
      userProps.emailVerified = identity.emailVerified ?? false;
    }
    await createRunUser(
      { async createUser(props) { await adminAuth.createUser(props); } },
      runUids,
      userProps,
    );
    return uid;
  }

  const userStore = createAdminUserStore(adminAuth);

  const deployOrder = orderDeployScenarios(deployScenarios);
  const deployInput = { beforeRules, mountKey: auditKey };
  let restoreVerified = false;
  let dataCleanupVerified = false;
  let userCleanupVerified = false;
  let deployed = false;

  coordinator.registerCleanup(async () => {
    if (!deployed) {
      return;
    }
    await restoreRtdbRulesWithRetry({
      beforeText: JSON.stringify(beforeRules),
      writeText: (text) => writeRules(JSON.parse(text) as Record<string, unknown>),
      readText: async () => JSON.stringify(await readRules()),
      canonicalize: (text) => canonicalize(JSON.parse(text)),
    });
    deployed = false;
    restoreVerified = true;
  });

  async function captureOperations(): Promise<CapturedObservation[]> {
    const observations: CapturedObservation[] = [];
    if (scenarios.length === 0) {
      return observations;
    }
    const auditSubtree: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      auditSubtree[scenario.id] = JSON.parse(scenario.rules);
    }
    deployed = true;
    await writeRules({ ...beforeRules, [auditKey]: auditSubtree });
    console.log(`${LOG_PREFIX} deployed ${scenarios.length} scenario subtree(s) under /${auditKey}. Waiting 8s to propagate.`);
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    for (const scenario of scenarios) {
      const behavior: Record<string, 'ALLOW' | 'DENY'> = {};
      for (const tc of scenario.cases as RtdbTestCase[]) {
        if (tc.identity) {
          const uid = await identityUser(tc.identity);
          if (auth.currentUser?.uid !== uid) {
            if (auth.currentUser) {
              await signOut(auth);
            }
            let lastError: unknown;
            for (let attempt = 0; attempt < 5 && auth.currentUser?.uid !== uid; attempt += 1) {
              if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
              }
              try {
                const token = await mintCustomToken(serviceAccount, uid, tc.identity.claims ?? {});
                await signInWithCustomToken(auth, token);
              } catch (error) {
                lastError = error;
              }
            }
            if (auth.currentUser?.uid !== uid) {
              throw new Error(
                `custom-token sign-in for case "${tc.description}" failed: ${formatErrorMessage(lastError)}`,
              );
            }
          }
        } else if (tc.claims) {
          if (auth.currentUser) {
            await signOut(auth);
          }
          const customToken = await adminAuth.createCustomToken(claimsUid, tc.claims);
          await signInWithCustomToken(auth, customToken);
        } else if (tc.authPresent && (!auth.currentUser || !auth.currentUser.isAnonymous)) {
          if (auth.currentUser) {
            await signOut(auth);
          }
          runUids.add((await signInAnonymously(auth)).user.uid);
        } else if (!tc.authPresent && auth.currentUser) {
          await signOut(auth);
        }

        const liveUid = auth.currentUser?.uid ?? '';
        const opPath = substituteUid(tc.opPath, liveUid);
        let newData: unknown = undefined;
        if (tc.newData !== undefined) {
          newData = substituteUid(tc.newData, liveUid);
        }
        let mockData: unknown = undefined;
        if (tc.mockData !== undefined) {
          mockData = substituteUid(tc.mockData, liveUid);
        }
        const mountPath = `/${auditKey}/${scenario.id}`;
        const fullPath = `${mountPath}${opPath}`;

        await adminDb.ref(mountPath).set(null);
        for (const [seedPath, seedValue] of Object.entries(tc.seed ?? {})) {
          await adminDb
            .ref(`${mountPath}${substituteUid(seedPath, liveUid)}`)
            .set(substituteUid(seedValue, liveUid));
        }
        if (mockData !== undefined && mockData !== null) {
          await adminDb.ref(fullPath).set(mockData);
        }

        let allowed = false;
        try {
          if (tc.operation === 'read') {
            await rtdbGet(rtdbRef(rtdb, fullPath));
          } else if (tc.operation === 'query') {
            if (!tc.query) {
              throw new Error(`query case "${tc.description}" is missing a query definition`);
            }
            const constraints = queryConstraintsOf(substituteUid(tc.query, liveUid)).map((spec) => {
              switch (spec[0]) {
                case 'orderByChild': return orderByChild(spec[1]);
                case 'orderByKey': return orderByKey();
                case 'orderByValue': return orderByValue();
                case 'orderByPriority': return orderByPriority();
                case 'equalTo': return equalTo(spec[1]);
                case 'startAt': return startAt(spec[1]);
                case 'endAt': return endAt(spec[1]);
                case 'limitToFirst': return limitToFirst(spec[1]);
                case 'limitToLast': return limitToLast(spec[1]);
              }
            });
            await rtdbGet(rtdbQuery(rtdbRef(rtdb, fullPath), ...constraints));
          } else if (tc.operation === 'update') {
            await rtdbUpdate(rtdbRef(rtdb, fullPath), newData as Record<string, unknown>);
          } else {
            await rtdbSet(rtdbRef(rtdb, fullPath), newData ?? null);
          }
          allowed = true;
        } catch (error) {
          if (error instanceof Error && error.message.includes('is missing a query definition')) {
            throw error;
          }
          allowed = false;
        }
        behavior[tc.description] = allowed ? 'ALLOW' : 'DENY';
      }
      observations.push({ scenario, behavior });
      const allows = Object.values(behavior).filter((v) => v === 'ALLOW').length;
      const denies = Object.values(behavior).filter((v) => v === 'DENY').length;
      console.log(`  OK ${scenario.id.padEnd(28)} allow=${allows} deny=${denies}`);
    }

    if (auth.currentUser) {
      await runBestEffortTeardown(LOG_PREFIX, 'auth sign-out', () => signOut(auth));
    }
    return observations;
  }

  async function restoreBeforeLate(): Promise<void> {
    if (!deployed) {
      return;
    }
    await restoreBeforeLatePhaseWithRetry({ writeRules, readRules }, beforeRules);
    deployed = false;
  }

  async function restoreAndCleanUp(): Promise<void> {
    try {
      if (deployed) {
        await coordinator.runRestore();
        console.log(`${LOG_PREFIX} restore verified -- rules read back identical to pre-run snapshot.`);
      } else {
        const afterRules = await readRules();
        if (canonicalize(afterRules) === beforeCanonical) {
          restoreVerified = true;
          console.log(`${LOG_PREFIX} restore verified -- rules read back identical to pre-run snapshot.`);
        } else {
          console.error(`${LOG_PREFIX} RESTORE VERIFY FAILED -- read-back rules differ from the pre-run snapshot.`);
        }
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} RESTORE FAILED: ${formatErrorMessage(error)}`);
    }
    try {
      await verifyRunDataCleanup(store, auditKey);
      dataCleanupVerified = true;
      console.log(`${LOG_PREFIX} data cleanup verified -- /${auditKey} deleted and absent from a shallow root read.`);
    } catch (error) {
      console.error(`${LOG_PREFIX} DATA CLEANUP FAILED: ${formatErrorMessage(error)}`);
    }
    try {
      const failures: string[] = [];
      for (const uid of runUids) {
        try {
          await verifyRunUserCleanup(userStore, uid);
        } catch (error) {
          failures.push(formatErrorMessage(error));
        }
      }
      if (failures.length > 0) {
        throw new Error(failures.join('; '));
      }
      userCleanupVerified = true;
      console.log(`${LOG_PREFIX} user cleanup verified: ${runUids.size} run-created Auth uid(s) deleted and absent from a lookup.`);
    } catch (error) {
      console.error(`${LOG_PREFIX} USER CLEANUP FAILED: ${formatErrorMessage(error)}`);
    }
    await runBestEffortTeardown(LOG_PREFIX, 'web app', () => deleteApp(app));
    await runBestEffortTeardown(LOG_PREFIX, 'admin app', () => adminDeleteApp(adminApp));
  }

  function assertCleanRun(): void {
    if (!restoreVerified) {
      throw new Error('restore invariant NOT verified -- refusing to write observations. Inspect the database rules manually.');
    }
    if (!dataCleanupVerified) {
      throw new Error(`data cleanup invariant NOT verified -- refusing to write observations. Delete /${auditKey} manually.`);
    }
    if (!userCleanupVerified) {
      throw new Error(`user cleanup invariant NOT verified; refusing to write observations. Delete the Auth users ${[...runUids].join(', ')} manually.`);
    }
  }

  function writeObservation({ scenario, behavior }: CapturedObservation): void {
    mkdirSync(OBS_DIR, { recursive: true });
    const path = observationPath(scenario);
    let linkage: ObservationLinkage;
    if (existsSync(path)) {
      linkage = observationLinkageOf(JSON.parse(readFileSync(path, 'utf8')));
    } else {
      linkage = observationLinkageOf(undefined);
    }
    let description: string;
    if ('deployCases' in scenario) {
      description = `RTDB rules deploy verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by dry-run deploys to the rules endpoint, which validate without deploying. ${scenario.rationale}`;
    } else {
      description = `RTDB rules production verdicts for corpus scenario "${scenario.id}" (${scenario.fm}). Captured by deploy-observe-restore (RTDB has no server-side rules test API). ${scenario.rationale}`;
    }
    const obs: Observation = {
      name: rtdbObservationName(scenario),
      matrixRow: linkage.matrixRow,
      rowIds: linkage.rowIds,
      description,
      observedAt: new Date().toISOString(),
      fbSdkVersion,
      projectId: config.projectId,
      behavior,
    };
    writeFileSync(path, JSON.stringify(obs, null, 2) + '\n');
    console.log(`  -> wrote ${rtdbObservationName(scenario)}.json`);
  }

  let exitCode = 1;
  try {
    exitCode = await runCapturePhases({
      earlyDeploys: () => runDeployScenarios(endpoint, deployOrder.beforeOperations, deployInput),
      operations: captureOperations,
      restoreBeforeLate,
      lateDeploys: () => runDeployScenarios(endpoint, deployOrder.afterOperations, deployInput),
      restoreAndCleanUp,
      assertClean: assertCleanRun,
      write: writeObservation,
      log: (line) => console.error(line),
    });
  } finally {
    uninstallSignals();
  }

  let outcome = 'capture incomplete (the scenarios named above have no observation)';
  if (exitCode === 0) {
    outcome = 'capture complete';
  }
  console.log(`\n${LOG_PREFIX} ${outcome}: rules restored, run data and run users removed, all read-back verified.`);
  console.log(`${LOG_PREFIX} Existing observation matrixRow/rowIds linkage was preserved.`);
  console.log(`${LOG_PREFIX} NEXT: review the observation diff, then run \`bun run compat:validate\`.`);
  return exitCode;
}

if (import.meta.main && process.argv.includes('--multi-instance-sdk')) {
  requireCaptureMode({
    label: 'oracle:rtdb-instances',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    extraFlags: '--multi-instance-sdk',
  });
  const path = join(HERE, '..', 'observations', 'rtdb-modular', `${MULTI_INSTANCE_OBSERVATION}.json`);
  const observation = JSON.parse(readFileSync(path, 'utf8')) as Observation;
  if (observation.fbSdkVersion !== resolvedFirebaseVersion()) {
    throw new Error(
      `the observation records firebase ${observation.fbSdkVersion}; this checkout resolves ${resolvedFirebaseVersion()}.`,
    );
  }
  observation.behavior.sdk = await captureMultiInstanceSdk();
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`  -> recorded behavior.sdk in ${MULTI_INSTANCE_OBSERVATION}.json`);
  process.exit(0);
}

if (import.meta.main && process.argv.includes('--multi-instance')) {
  requireCaptureMode({
    label: 'oracle:rtdb-instances',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    extraFlags: '--multi-instance',
    missingCredentials: () => {
      const missing: string[] = [];
      if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) missing.push('PYRIC_ORACLE_FIREBASE_CONFIG');
      if (!process.env.PYRIC_ORACLE_SECOND_DATABASE_URL) {
        missing.push('PYRIC_ORACLE_SECOND_DATABASE_URL');
      }
      if (!oracleCredentialConfigured(process.env)) {
        missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
      }
      if (missing.length > 0) return missing.join(', ');
      return null;
    },
  });
  await captureMultiInstance();
  process.exit(0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const selection = selectRtdbScenarios(args);
  requireCaptureMode({
    label: 'oracle:rules-rtdb',
    scriptPath: 'packages/conformance/src/run-rules-rtdb.ts',
    argv: args,
    preview: () => printInertPlan(selection, OBS_DIR),
    missingCredentials: () => {
      const missing: string[] = [];
      if (!process.env.PYRIC_ORACLE_FIREBASE_CONFIG) missing.push('PYRIC_ORACLE_FIREBASE_CONFIG');
      if (!oracleCredentialConfigured(process.env)) {
        missing.push('PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID');
      }
      if (missing.length > 0) return missing.join(', ');
      return null;
    },
  });
  process.exitCode = await capture(selection);
}
