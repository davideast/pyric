/**
 * Multi-instance RTDB isolation oracle capture (`--multi-instance` and
 * `--multi-instance-sdk`) plus strict JSON rules-text guards shared with
 * `run-rules-rtdb.ts`.
 *
 * Routes every REST rules and run-data call through `fetchWithTokenAndRateLimitRetry`
 * so 429 rate-limit bursts and 1-hour OAuth token expiry never break restore or
 * cleanup verification.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RTDB_RULES_SCOPE } from './oracle-access-token.ts';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  oracleAppOptions,
} from './oracle-credential.ts';
import { assertDedicatedOracleRtdbUrl } from './oracle-run-setup.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from './oracle-signal-restore.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import {
  createAdminUserStore,
  formatErrorMessage,
  mintCustomToken,
  runBestEffortTeardown,
  verifyRunDataCleanup,
  verifyRunUserCleanup,
  type RunDataStore,
} from './rtdb-rules-cleanup.ts';
import { canonicalize } from './rtdb-rules-deploy.ts';
import {
  createRefreshingAccessToken,
  fetchWithTokenAndRateLimitRetry,
} from './rtdb-rules-endpoint-resilience.ts';
import { assertMatchingOracleProjects } from './rtdb-rules-selection.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PREFIX = '[oracle:rtdb-instances]';

/** The observation the multi-instance capture writes. */
export const MULTI_INSTANCE_OBSERVATION = 'rtdb-modular-multiple-instances';

/** Rules each instance runs under the run-scoped key during the capture. */
export const MULTI_INSTANCE_RULES = {
  default: { '.read': 'auth != null', '.write': 'auth != null' },
  second: {
    open: { '.read': true, '.write': true },
    users: {
      $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' },
    },
  },
} as const;

interface MultiInstanceWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  databaseURL?: string;
}

/** Merges `subtree` under `auditKey` after verifying strict JSON and `false` root grants. */
export function instanceRulesForCapture(
  instance: string,
  beforeText: string,
  auditKey: string,
  subtree: unknown,
): string {
  const before = capturableRules(instance, beforeText);
  return JSON.stringify({ ...before, rules: { ...before.rules, [auditKey]: subtree } });
}

export function capturableRules(
  instance: string,
  beforeText: string,
): { rules: Record<string, unknown> } & Record<string, unknown> {
  let before: { rules?: Record<string, unknown> } & Record<string, unknown>;
  try {
    before = JSON.parse(beforeText) as typeof before;
  } catch (error) {
    throw new Error(
      `refusing to run: the rules of ${instance} are not plain JSON (they may carry comments), so the run cannot add its subtree and keep them in force (${formatErrorMessage(error)}).`,
    );
  }
  const root = before.rules ?? {};
  for (const access of ['.read', '.write']) {
    const grant = root[access];
    if (grant !== undefined && grant !== false) {
      throw new Error(
        `refusing to run: the root ${access} rule of ${instance} is not false, so it would grant access inside the run's subtree.`,
      );
    }
  }
  return { ...before, rules: root };
}

export function verifyRulesTextRestored(
  instance: string,
  beforeText: string,
  afterText: string,
): { exact: boolean } {
  if (afterText === beforeText) {
    return { exact: true };
  }
  let same = false;
  try {
    same = canonicalize(JSON.parse(afterText)) === canonicalize(JSON.parse(beforeText));
  } catch (error) {
    if (error instanceof SyntaxError) {
      same = false;
    } else {
      throw error;
    }
  }
  if (!same) {
    throw new Error(
      `restore NOT verified on ${instance}: the read-back rules differ from the pre-run rules.`,
    );
  }
  return { exact: false };
}

/** Captures cross-instance RTDB isolation (`deploy -> observe -> restore + read-back` on both instances). */
export async function captureMultiInstance(): Promise<void> {
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInWithCustomToken, signOut } = await import('firebase/auth');
  const { getDatabase, ref: rtdbRef, get: rtdbGet, set: rtdbSet, onValue } = await import(
    'firebase/database'
  );
  const { initializeApp: adminInitializeApp, deleteApp: adminDeleteApp } = await import(
    'firebase-admin/app'
  );
  const { getAuth: getAdminAuth } = await import('firebase-admin/auth');

  const rawConfigText = process.env.PYRIC_ORACLE_FIREBASE_CONFIG ?? '{}';
  const config = JSON.parse(rawConfigText) as MultiInstanceWebConfig;
  const secondUrl = process.env.PYRIC_ORACLE_SECOND_DATABASE_URL;
  if (!config.databaseURL) {
    throw new Error('PYRIC_ORACLE_FIREBASE_CONFIG has no databaseURL.');
  }
  if (!secondUrl) {
    throw new Error('PYRIC_ORACLE_SECOND_DATABASE_URL names the second instance the capture runs against.');
  }
  const defaultUrl = config.databaseURL.replace(/\/$/, '');
  const second = assertDedicatedOracleRtdbUrl(secondUrl, config.projectId);
  const serviceAccount = await loadOracleServiceAccount();
  assertMatchingOracleProjects(config, serviceAccount);
  const fbSdkVersion = resolvedFirebaseVersion();
  const instances = { default: defaultUrl, second } as const;
  console.log(`${LOG_PREFIX} project: ${config.projectId}`);
  console.log(`${LOG_PREFIX} instances: ${new URL(defaultUrl).host}, ${new URL(second).host}`);

  const coordinator = createSignalRestoreCoordinator(LOG_PREFIX);
  const uninstallSignals = coordinator.installSignals();
  const tokenProvider = createRefreshingAccessToken({
    mint: () => oracleAccessToken(serviceAccount, RTDB_RULES_SCOPE),
  });

  async function readRulesText(url: string): Promise<string> {
    const res = await fetchWithTokenAndRateLimitRetry(
      (token) => `${url}/.settings/rules.json?access_token=${encodeURIComponent(token)}`,
      undefined,
      `read rules (${new URL(url).host})`,
      { tokenProvider, logPrefix: LOG_PREFIX },
    );
    if (!res.ok) {
      throw new Error(`read rules failed on ${new URL(url).host}: ${res.status}`);
    }
    return res.text();
  }

  async function writeRulesText(url: string, text: string): Promise<void> {
    const res = await coordinator.trackMutation(
      fetchWithTokenAndRateLimitRetry(
        (token) =>
          `${url}/.settings/rules.json?access_token=${encodeURIComponent(token)}&print=silent`,
        { method: 'PUT', body: text },
        `write rules (${new URL(url).host})`,
        { tokenProvider, logPrefix: LOG_PREFIX },
      ),
    );
    if (!res.ok) {
      throw new Error(`write rules failed on ${new URL(url).host}: ${res.status} ${await res.text()}`);
    }
  }

  async function adminRead(url: string, path: string): Promise<unknown> {
    const res = await fetchWithTokenAndRateLimitRetry(
      (token) => `${url}/${path}.json?access_token=${encodeURIComponent(token)}`,
      undefined,
      `admin read (${new URL(url).host})`,
      { tokenProvider, logPrefix: LOG_PREFIX },
    );
    if (!res.ok) {
      throw new Error(`admin read failed on ${new URL(url).host}: ${res.status}`);
    }
    return res.json();
  }

  function dataStore(url: string): RunDataStore {
    return {
      async deleteNamespace(auditKey) {
        const res = await fetchWithTokenAndRateLimitRetry(
          (token) =>
            `${url}/${auditKey}.json?access_token=${encodeURIComponent(token)}&print=silent`,
          { method: 'DELETE' },
          `delete run data (${new URL(url).host})`,
          { tokenProvider, logPrefix: LOG_PREFIX },
        );
        if (!res.ok) {
          throw new Error(`delete run data failed on ${new URL(url).host}: ${res.status}`);
        }
      },
      async shallowRootKeys() {
        const res = await fetchWithTokenAndRateLimitRetry(
          (token) => `${url}/.json?shallow=true&access_token=${encodeURIComponent(token)}`,
          undefined,
          `shallow root read (${new URL(url).host})`,
          { tokenProvider, logPrefix: LOG_PREFIX },
        );
        if (!res.ok) {
          throw new Error(`shallow root read failed on ${new URL(url).host}: ${res.status}`);
        }
        const body = (await res.json()) as Record<string, unknown> | null;
        if (body === null) {
          return [];
        }
        return Object.keys(body);
      },
    };
  }

  const before = {
    default: await readRulesText(defaultUrl),
    second: await readRulesText(second),
  };
  console.log(`${LOG_PREFIX} snapshotted the rules of both instances.`);
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auditKey = `pyric_oracle_instances_${runId}`;
  const deploy = {
    default: instanceRulesForCapture(
      'the default instance',
      before.default,
      auditKey,
      MULTI_INSTANCE_RULES.default,
    ),
    second: instanceRulesForCapture(
      'the second instance',
      before.second,
      auditKey,
      MULTI_INSTANCE_RULES.second,
    ),
  };
  const uid = `pyric-oracle-instances-${runId}`;
  const app = initializeApp(config, `oracle-rtdb-instances-${runId}`);
  const auth = getAuth(app);
  const adminApp = adminInitializeApp(
    oracleAppOptions(serviceAccount),
    `oracle-rtdb-instances-admin-${runId}`,
  );
  const adminAuth = getAdminAuth(adminApp);
  const runUids = new Set<string>([uid]);
  const userStore = createAdminUserStore(adminAuth);
  const outcome = (operation: Promise<unknown>): Promise<'ALLOW' | 'DENY'> =>
    operation.then(
      () => 'ALLOW' as const,
      () => 'DENY' as const,
    );
  const behavior: Record<string, unknown> = {};
  const restored: Record<string, { exact: boolean } | string> = {};
  let deployed = false;
  coordinator.registerCleanup(async () => {
    for (const [name, url] of Object.entries(instances)) {
      const targetBefore = before[name as keyof typeof before];
      try {
        if (deployed) {
          await restoreRtdbRulesWithRetry({
            beforeText: targetBefore,
            writeText: (text) => writeRulesText(url, text),
            readText: () => readRulesText(url),
            canonicalize: (text) => canonicalize(JSON.parse(text)),
          });
        }
        const checked = verifyRulesTextRestored(name, targetBefore, await readRulesText(url));
        restored[name] = checked;
        let suffix = ' (same rules, reformatted)';
        if (checked.exact) {
          suffix = ' (text identical)';
        }
        console.log(`${LOG_PREFIX} restore verified on ${name}${suffix}.`);
      } catch (error) {
        restored[name] = formatErrorMessage(error);
        console.error(`${LOG_PREFIX} RESTORE FAILED on ${name}: ${restored[name]}`);
      }
    }
  });
  let dataCleanupVerified = false;
  let userCleanupVerified = false;

  try {
    deployed = true;
    await writeRulesText(defaultUrl, deploy.default);
    await writeRulesText(second, deploy.second);
    console.log(
      `${LOG_PREFIX} deployed a different subtree to each instance under /${auditKey}. Waiting 8s to propagate.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    const defaultDb = getDatabase(app);
    const secondDb = getDatabase(app, second);
    const probe = `${auditKey}/open/probe`;
    behavior.signedOut = {
      defaultWrite: await outcome(rtdbSet(rtdbRef(defaultDb, probe), 'default')),
      secondWrite: await outcome(rtdbSet(rtdbRef(secondDb, probe), 'second')),
    };
    behavior.isolation = {
      secondWriteReadOnSecond: await adminRead(second, probe),
      secondWriteReadOnDefault: await adminRead(defaultUrl, probe),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && auth.currentUser?.uid !== uid; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
      try {
        const customToken = await mintCustomToken(serviceAccount, uid, {});
        await signInWithCustomToken(auth, customToken);
      } catch (error) {
        lastError = error;
      }
    }
    if (auth.currentUser?.uid !== uid) {
      throw new Error(`custom-token sign-in failed: ${formatErrorMessage(lastError)}`);
    }
    behavior.signedIn = {
      defaultWrite: await outcome(rtdbSet(rtdbRef(defaultDb, probe), 'default')),
      secondOwnUserPath: await outcome(rtdbSet(rtdbRef(secondDb, `${auditKey}/users/${uid}`), 'own')),
      secondOtherUserPath: await outcome(
        rtdbSet(rtdbRef(secondDb, `${auditKey}/users/another-user`), 'other'),
      ),
      secondPathWithoutRules: await outcome(rtdbGet(rtdbRef(secondDb, `${auditKey}/closed`))),
      defaultReadOfSecondOnlyPath: await outcome(
        rtdbGet(rtdbRef(defaultDb, `${auditKey}/users/${uid}`)),
      ),
    };
    behavior.isolationAfterBothWrites = {
      defaultHolds: await adminRead(defaultUrl, probe),
      secondHolds: await adminRead(second, probe),
      secondUserPathOnDefault: await adminRead(defaultUrl, `${auditKey}/users/${uid}`),
    };
    await signOut(auth);

    const missingName = `pyric-oracle-missing-${runId.replace('_', '-')}`;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const missing = getDatabase(app, `https://${missingName}.firebaseio.com`);
      const settles = (operation: Promise<unknown>) =>
        Promise.race([
          operation.then(
            () => 'resolved',
            (error: Error) => `rejected: ${error.message}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending after 20s'), 20_000)),
        ]);
      const listened = new Promise((resolve, reject) => {
        onValue(rtdbRef(missing, 'probe'), resolve, reject);
      });
      behavior.missingInstance = {
        get: await settles(rtdbGet(rtdbRef(missing, 'probe'))),
        onValue: await settles(listened),
        warnings: warnings
          .filter((line) => line.includes('FIREBASE WARNING'))
          .map((line) =>
            line.replace(/^\[[^\]]+\]\s+/, '').replaceAll(missingName, '<missing>').trim(),
          ),
      };
    } finally {
      console.warn = warn;
    }
  } finally {
    try {
      await coordinator.runRestore();
    } finally {
      uninstallSignals();
    }
    try {
      for (const url of Object.values(instances)) {
        await verifyRunDataCleanup(dataStore(url), auditKey);
      }
      dataCleanupVerified = true;
      console.log(`${LOG_PREFIX} data cleanup verified: /${auditKey} absent from both instances.`);
    } catch (error) {
      console.error(`${LOG_PREFIX} DATA CLEANUP FAILED: ${formatErrorMessage(error)}`);
    }
    try {
      for (const id of runUids) {
        await verifyRunUserCleanup(userStore, id);
      }
      userCleanupVerified = true;
      console.log(`${LOG_PREFIX} user cleanup verified: ${runUids.size} run-created Auth uid deleted.`);
    } catch (error) {
      console.error(`${LOG_PREFIX} USER CLEANUP FAILED: ${formatErrorMessage(error)}`);
    }
    await runBestEffortTeardown(LOG_PREFIX, 'web app', () => deleteApp(app));
    await runBestEffortTeardown(LOG_PREFIX, 'admin app', () => adminDeleteApp(adminApp));
  }

  const unrestored = Object.entries(restored).filter(([, result]) => typeof result === 'string');
  if (unrestored.length > 0 || Object.keys(restored).length !== 2) {
    throw new Error(
      "restore invariant NOT verified on every instance; refusing to write the observation. Inspect both instances' rules manually.",
    );
  }
  if (!dataCleanupVerified) {
    throw new Error(`data cleanup NOT verified; delete /${auditKey} on both instances manually.`);
  }
  if (!userCleanupVerified) {
    throw new Error(`user cleanup NOT verified; delete Auth user ${uid} manually.`);
  }

  const observation = {
    name: MULTI_INSTANCE_OBSERVATION,
    matrixRow: 'rtdb-modular#MI1',
    rowIds: [
      'rtdb-modular#MI1',
      'rtdb-modular#MI2',
      'rtdb-modular#MI3',
      'rtdb-modular#MI5',
      'rtdb-modular#MI6',
      'rtdb-modular#MI7',
    ],
    description:
      "Two RTDB instances of one project, the default instance and a second one, each with a different ruleset deployed under a run-scoped key: client writes signed out and as one custom-token user, the value each instance holds afterwards read with an admin token, and the SDK's behavior for an instance URL that names no instance. Captured by deploy-observe-restore on both instances; rules restored and read back, run data and the run user deleted.",
    observedAt: new Date().toISOString(),
    fbSdkVersion,
    projectId: config.projectId,
    behavior: { rules: MULTI_INSTANCE_RULES, ...behavior, sdk: await captureMultiInstanceSdk() },
  };
  const outputPath = join(
    HERE,
    '..',
    'observations',
    'rtdb-modular',
    `${MULTI_INSTANCE_OBSERVATION}.json`,
  );
  const serialized = `${JSON.stringify(observation, null, 2).replaceAll(uid, '<UID>').replaceAll(auditKey, '<run>')}\n`;
  writeFileSync(outputPath, serialized);
  console.log(`  -> wrote ${MULTI_INSTANCE_OBSERVATION}.json`);
}

/**
 * The production SDK's handle and reference identity across instances, which
 * it decides without a connection. Read-only and offline; recorded under
 * `behavior.sdk` of the multi-instance observation.
 */
export async function captureMultiInstanceSdk(): Promise<Record<string, unknown>> {
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getDatabase, ref, refFromURL } = await import('firebase/database');
  const outcome = (run: () => unknown): Record<string, unknown> => {
    try {
      const value = run();
      if (typeof value === 'string') {
        return { value };
      }
      return { value: 'returned' };
    } catch (error) {
      return { error: formatErrorMessage(error) };
    }
  };
  const app = initializeApp(
    { projectId: 'sdk-project', apiKey: 'unused' },
    `oracle-rtdb-instances-sdk-${Date.now()}`,
  );
  const noProject = initializeApp(
    { apiKey: 'unused' },
    `oracle-rtdb-instances-sdk-none-${Date.now()}`,
  );
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const defaultDb = getDatabase(app);
    const second = getDatabase(app, 'https://second.firebaseio.com');
    return {
      referenceUrls: {
        defaultRoot: ref(defaultDb).toString(),
        secondPath: ref(second, 'a b/c').toString(),
        regional: ref(
          getDatabase(app, 'https://reg.europe-west1.firebasedatabase.app'),
          'a',
        ).toString(),
        namespaceQuery: ref(getDatabase(app, 'https://host.firebaseio.com?ns=named'), 'a').toString(),
      },
      sameArgumentSameHandle: getDatabase(app, 'https://second.firebaseio.com') === second,
      defaultUrlAfterDefault: outcome(() =>
        getDatabase(app, 'https://sdk-project-default-rtdb.firebaseio.com'),
      ),
      trailingSlashAfterOpen: outcome(() => getDatabase(app, 'https://second.firebaseio.com/')),
      refFromUrlSameHost: outcome(() =>
        refFromURL(second, 'https://second.firebaseio.com/a/b%20c').toString(),
      ),
      refFromUrlOtherHost: outcome(() =>
        refFromURL(second, 'https://third.firebaseio.com/a'),
      ),
      noProjectNoUrl: outcome(() => getDatabase(noProject)),
    };
  } finally {
    console.error = originalConsoleError;
    await deleteApp(app);
    await deleteApp(noProject);
  }
}
