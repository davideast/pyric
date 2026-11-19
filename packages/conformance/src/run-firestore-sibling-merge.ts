#!/usr/bin/env bun
/**
 * Pure-Node production Firestore capture runner for row `firestore-rules#190`
 * (`packages/conformance/observations/firestore-rules/rules-firestore-atomic-batch-sibling-merge.json`).
 *
 * Temporarily deploys `injectFirestoreProbeRules` scoped to `__pyric_firestore_cdd/<runId>`,
 * verifies rules readiness on the data plane, runs the solo DENY controls and
 * multi-document `writeBatch` sibling-merge probes via the Node Web SDK, refuses
 * to write unless `assertGetAfterProbeControls` passes, and restores + verifies
 * the exact prior `cloud.firestore` release pointer in `finally` and signal handlers.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../rules-corpus/firestore/index.ts';
import { requireCaptureMode } from './capture-mode-guard.ts';
import {
  hostedTestApiDiagnostics,
  injectFirestoreProbeRules,
  replaceSelectedRulesFile,
  selectFirestoreRulesFile,
  snapshotFirestoreRules,
  withSignalGuardedFirestoreRules,
} from './firestore-real-rules.ts';
import {
  SIBLING_MERGE_CASE_IDS,
  assertGetAfterProbeControls,
  siblingMergeProbePlan,
  type ProbeData,
  type ProbeVerdict,
  type ProbeWrite,
} from './firestore-real-sibling-merge.ts';
import { firestoreScenarioInputDigest } from './firestore-rules-input-digest.ts';
import {
  loadOracleServiceAccount,
  oracleAppOptions,
  oracleCredentialConfigured,
} from './oracle-credential.ts';
import { sanitizeOracleCustomUid, signInOracleClientAuth } from './oracle-run-auth-session.ts';
import { resolvedFirebaseVersion } from './package-version.ts';
import { resolveProbeWebConfig } from './sdk-probe-runtime.ts';
import { accessHeaders } from './storage-stdlib-real-api.ts';
import { acquireRunLock } from './storage-stdlib-real-lock.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_SIBLING_MERGE_OBSERVATION_PATH = join(
  HERE,
  '..',
  'observations',
  'firestore-rules',
  'rules-firestore-atomic-batch-sibling-merge.json',
);
const LOCK_PATH = '/tmp/pyric-firestore-real.lock';
const SIBLING_MERGE_SCENARIO_ID = 'atomic-batch-sibling-merge';
const SIBLING_MERGE_CASE =
  'getAfter reflects merged pre-existing fields alongside batch updates ALLOW';
const SIBLING_MERGE_DESCRIPTION =
  'An authenticated Web SDK batch against temporarily deployed production rules updates one field of a seeded companion document and creates a document whose rule reads both the updated field and an untouched pre-existing field through getAfter(). The same create alone is the DENY control, and a batch that updates both fields of a second companion is the ALLOW control. The hosted Rules Test API limitation is retained separately in diagnostics.';

const INITIAL_PROPAGATION_MS = 10_000;
const POST_READY_SETTLE_MS = 5_000;
const READINESS_DEADLINE_MS = 90_000;
const READINESS_CONSECUTIVE_SUCCESSES = 5;

export interface SiblingMergeMeasuredVerdicts {
  rulesGetAfterSoloPrimary: ProbeVerdict;
  rulesGetAfterSiblingMergeSoloPrimary: ProbeVerdict;
  rulesGetAfterSiblingMergeBatch: ProbeVerdict;
  rulesGetAfterSiblingMergeFullBatch: ProbeVerdict;
}

export interface SiblingMergeRunnerClient {
  seedAdminDoc(path: string, data: ProbeData): Promise<void>;
  writeClientSet(path: string, data: ProbeData): Promise<void>;
  commitClientBatch(writes: readonly ProbeWrite[]): Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'permission-denied';
}

async function evaluateWriteVerdict(operation: () => Promise<void>): Promise<ProbeVerdict> {
  try {
    await operation();
    return 'ALLOW';
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return 'DENY';
    }
    throw error;
  }
}

async function waitForProbeRulesReady(options: {
  client: SiblingMergeRunnerClient;
  readinessPath: string;
  deadlineMs: number;
  requiredSuccesses: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<void> {
  const deadline = options.now() + options.deadlineMs;
  let consecutive = 0;
  let lastError: unknown;

  while (options.now() < deadline) {
    try {
      await options.client.writeClientSet(options.readinessPath, { ready: true });
      consecutive += 1;
      if (consecutive >= options.requiredSuccesses) {
        return;
      }
      await options.sleep(1_000);
    } catch (error) {
      lastError = error;
      if (!isPermissionDeniedError(error)) {
        throw error;
      }
      consecutive = 0;
      await options.sleep(1_000);
    }
  }

  throw new Error('timed out waiting for Firestore sibling-merge probe rules propagation', {
    cause: lastError,
  });
}

export async function measureSiblingMergeVerdicts(options: {
  runId: string;
  client: SiblingMergeRunnerClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readinessDeadlineMs?: number;
  requiredReadinessSuccesses?: number;
  postReadySettleMs?: number;
}): Promise<SiblingMergeMeasuredVerdicts> {
  let sleep = defaultSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  let now: () => number = () => Date.now();
  if (options.now !== undefined) {
    now = options.now;
  }
  let readinessDeadlineMs = READINESS_DEADLINE_MS;
  if (options.readinessDeadlineMs !== undefined) {
    readinessDeadlineMs = options.readinessDeadlineMs;
  }
  let requiredReadinessSuccesses = READINESS_CONSECUTIVE_SUCCESSES;
  if (options.requiredReadinessSuccesses !== undefined) {
    requiredReadinessSuccesses = options.requiredReadinessSuccesses;
  }
  let postReadySettleMs = POST_READY_SETTLE_MS;
  if (options.postReadySettleMs !== undefined) {
    postReadySettleMs = options.postReadySettleMs;
  }

  const rulesBase = `__pyric_firestore_cdd/${options.runId}/rules_get_after`;
  const readinessPath = `__pyric_firestore_cdd/${options.runId}/browser/readiness`;
  const plan = siblingMergeProbePlan(options.runId);

  await options.client.seedAdminDoc(`${rulesBase}/companion`, { count: 0 });
  for (const [path, data] of Object.entries(plan.seed)) {
    await options.client.seedAdminDoc(path, data);
  }

  await waitForProbeRulesReady({
    client: options.client,
    readinessPath,
    deadlineMs: readinessDeadlineMs,
    requiredSuccesses: requiredReadinessSuccesses,
    sleep,
    now,
  });
  if (postReadySettleMs > 0) {
    await sleep(postReadySettleMs);
  }

  const rulesGetAfterSoloPrimary = await evaluateWriteVerdict(() =>
    options.client.writeClientSet(`${rulesBase}/primary`, { solo: true }),
  );
  // Run the solo sibling-merge DENY control before the batch updates `sibling_merge_companion.modified` to true.
  const rulesGetAfterSiblingMergeSoloPrimary = await evaluateWriteVerdict(() =>
    options.client.writeClientSet(plan.soloPrimary.path, plan.soloPrimary.data),
  );
  const rulesGetAfterSiblingMergeBatch = await evaluateWriteVerdict(() =>
    options.client.commitClientBatch(plan.batch),
  );
  const rulesGetAfterSiblingMergeFullBatch = await evaluateWriteVerdict(() =>
    options.client.commitClientBatch(plan.fullBatch),
  );

  const measured: SiblingMergeMeasuredVerdicts = {
    rulesGetAfterSoloPrimary,
    rulesGetAfterSiblingMergeSoloPrimary,
    rulesGetAfterSiblingMergeBatch,
    rulesGetAfterSiblingMergeFullBatch,
  };
  assertGetAfterProbeControls({ ...measured });
  return measured;
}

function hasHostedLimitationRecord(diagnostics: unknown): boolean {
  if (typeof diagnostics !== 'object' || diagnostics === null || Array.isArray(diagnostics)) {
    return false;
  }
  if (!('hostedTestApiLimitation' in diagnostics)) {
    return false;
  }
  const unwrapped = hostedTestApiDiagnostics(diagnostics);
  if (typeof unwrapped !== 'object' || unwrapped === null || Array.isArray(unwrapped)) {
    return false;
  }
  return SIBLING_MERGE_CASE in unwrapped;
}

export function buildSiblingMergeObservation(options: {
  previousObservation: Record<string, unknown> & { diagnostics?: unknown };
  verdicts: SiblingMergeMeasuredVerdicts;
  observedAt: string;
  fbSdkVersion: string;
  projectId: string;
  originalRulesetName: string;
  probeRulesetName: string;
  restoredOriginalRelease: boolean;
  deployedRulesSource: string;
}): Record<string, unknown> {
  const trimmedProbeRuleset = options.probeRulesetName.trim();
  if (!options.restoredOriginalRelease || trimmedProbeRuleset === '') {
    throw new Error('probe did not complete with verified rules restoration');
  }

  assertGetAfterProbeControls({ ...options.verdicts });

  if (!hasHostedLimitationRecord(options.previousObservation.diagnostics)) {
    throw new Error(
      'existing rules-firestore-atomic-batch-sibling-merge.json lacks hostedTestApiLimitation diagnostics',
    );
  }
  const retainedHostedLimitation = hostedTestApiDiagnostics(options.previousObservation.diagnostics);

  const scenario = ALL_RULES_FIRESTORE_SCENARIOS.find(
    (entry) => entry.id === SIBLING_MERGE_SCENARIO_ID,
  );
  if (!scenario) {
    throw new Error(`missing Firestore rules corpus scenario '${SIBLING_MERGE_SCENARIO_ID}'`);
  }

  let matrixRow = 'firestore-rules#190';
  if (typeof options.previousObservation.matrixRow === 'string') {
    matrixRow = options.previousObservation.matrixRow;
  }
  let rowIds: string[] = ['firestore-rules#190'];
  if (
    Array.isArray(options.previousObservation.rowIds) &&
    options.previousObservation.rowIds.every((id) => typeof id === 'string')
  ) {
    rowIds = [...(options.previousObservation.rowIds as string[])];
  }

  return {
    ...options.previousObservation,
    name: 'rules-firestore-atomic-batch-sibling-merge',
    matrixRow,
    rowIds,
    description: SIBLING_MERGE_DESCRIPTION,
    observedAt: options.observedAt,
    fbSdkVersion: options.fbSdkVersion,
    projectId: options.projectId,
    inputDigest: firestoreScenarioInputDigest(scenario),
    behavior: {
      [SIBLING_MERGE_CASE]: options.verdicts.rulesGetAfterSiblingMergeBatch,
    },
    diagnostics: {
      productionDatabase: {
        siblingMergeBatch: options.verdicts.rulesGetAfterSiblingMergeBatch,
        siblingMergeSoloPrimary: options.verdicts.rulesGetAfterSiblingMergeSoloPrimary,
        siblingMergeFullBatch: options.verdicts.rulesGetAfterSiblingMergeFullBatch,
      },
      hostedTestApiLimitation: retainedHostedLimitation,
    },
    lifecycle: {
      originalRulesetName: options.originalRulesetName,
      probeRulesetName: trimmedProbeRuleset,
      restoredOriginalRelease: options.restoredOriginalRelease,
    },
    deployedRulesDigest: {
      algorithm: 'sha256',
      value: createHash('sha256').update(options.deployedRulesSource).digest('hex'),
    },
  };
}

async function withAdminRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown }).code !== 16) {
        throw error;
      }
      await defaultSleep(1_000);
    }
  }
  throw lastError;
}

async function runLiveSiblingMergeCapture(): Promise<void> {
  requireCaptureMode({
    label: 'firestore-rules-sibling-merge',
    scriptPath: 'packages/conformance/src/run-firestore-sibling-merge.ts',
    summary:
      'would capture Firestore getAfter() multi-document batch sibling-field merge verdicts (firestore-rules#190).',
    missingCredentials: () => {
      if (oracleCredentialConfigured(process.env)) {
        return null;
      }
      return 'PYRIC_ORACLE_SA_PATH or PYRIC_ORACLE_PROJECT_ID';
    },
  });

  const [
    { deleteApp, initializeApp },
    { deleteUser, getAuth },
    { doc, getFirestore, setDoc, terminate, writeBatch },
    { deleteApp: deleteAdminApp, initializeApp: initializeAdminApp },
    { getAuth: getAdminAuth },
    { getFirestore: getAdminFirestore },
  ] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
    import('firebase-admin/firestore'),
  ]);

  const releaseLock = acquireRunLock(LOCK_PATH);
  try {
    const sa = await loadOracleServiceAccount();
    const headers = await accessHeaders(sa);
    const web = await resolveProbeWebConfig(sa);
    const stamp = Date.now().toString(36);
    const nonce = Math.random().toString(36).slice(2, 8);
    const runId = `sm_${stamp}_${nonce}`;

    const snapshot = await snapshotFirestoreRules(sa, headers);
    const selected = selectFirestoreRulesFile(snapshot.ruleset);
    const content = injectFirestoreProbeRules(selected.content, runId);
    const files = replaceSelectedRulesFile(snapshot.ruleset, selected, content);

    const admin = initializeAdminApp(oracleAppOptions(sa), `pyric-sm-admin-${runId}`);
    const adminDb = getAdminFirestore(admin);
    const adminAuth = getAdminAuth(admin);
    const app = initializeApp(web, `pyric-sm-client-${runId}`);
    const clientAuth = getAuth(app);
    const db = getFirestore(app);
    const customUid = sanitizeOracleCustomUid(`sibling-merge-${runId}`);

    const rulesBase = `__pyric_firestore_cdd/${runId}/rules_get_after`;
    const cleanupPaths = [
      `__pyric_firestore_cdd/${runId}/browser/readiness`,
      `${rulesBase}/companion`,
      `${rulesBase}/primary`,
      ...SIBLING_MERGE_CASE_IDS.map((caseId) => `${rulesBase}/${caseId}`),
    ];

    let verdicts: SiblingMergeMeasuredVerdicts | undefined;
    let probeRulesetName = '';
    let restoreVerified = false;

    try {
      await signInOracleClientAuth(clientAuth, sa, customUid);
      const client: SiblingMergeRunnerClient = {
        async seedAdminDoc(path: string, data: ProbeData): Promise<void> {
          await withAdminRetry(() => adminDb.doc(path).set(data));
        },
        async writeClientSet(path: string, data: ProbeData): Promise<void> {
          await setDoc(doc(db, path), data);
        },
        async commitClientBatch(writes: readonly ProbeWrite[]): Promise<void> {
          const batch = writeBatch(db);
          for (const write of writes) {
            if (write.method === 'update') {
              batch.update(doc(db, write.path), write.data);
            } else {
              batch.set(doc(db, write.path), write.data);
            }
          }
          await batch.commit();
        },
      };

      const guarded = await withSignalGuardedFirestoreRules({
        label: '[firestore-rules-sibling-merge]',
        sa,
        headers,
        snapshot,
        files,
        beforeRestore: async () => {
          await Promise.allSettled(
            cleanupPaths.map((path) => withAdminRetry(() => adminDb.doc(path).delete())),
          );
          if (clientAuth.currentUser) {
            await deleteUser(clientAuth.currentUser).catch(() => undefined);
          }
          await adminAuth.deleteUser(customUid).catch(() => undefined);
          await terminate(db).catch(() => undefined);
          await deleteApp(app).catch(() => undefined);
        },
        onRestored: () => {
          console.log('[firestore-rules-sibling-merge] firestore rules restored and verified');
        },
        body: async () => {
          await defaultSleep(INITIAL_PROPAGATION_MS);
          verdicts = await measureSiblingMergeVerdicts({ runId, client });
        },
      });
      probeRulesetName = guarded.probeRulesetName;
      restoreVerified = guarded.restoreVerified;
    } finally {
      await adminDb.terminate().catch(() => undefined);
      await deleteAdminApp(admin).catch(() => undefined);
    }

    if (!verdicts) {
      throw new Error('sibling-merge probe did not record verdicts');
    }

    const previousSiblingMerge = JSON.parse(
      readFileSync(RULES_SIBLING_MERGE_OBSERVATION_PATH, 'utf8'),
    ) as Record<string, unknown> & { diagnostics?: unknown };

    const observation = buildSiblingMergeObservation({
      previousObservation: previousSiblingMerge,
      verdicts,
      observedAt: new Date().toISOString(),
      fbSdkVersion: resolvedFirebaseVersion(),
      projectId: sa.project_id,
      originalRulesetName: snapshot.release.rulesetName,
      probeRulesetName,
      restoredOriginalRelease: restoreVerified,
      deployedRulesSource: content,
    });

    mkdirSync(dirname(RULES_SIBLING_MERGE_OBSERVATION_PATH), { recursive: true });
    writeFileSync(
      RULES_SIBLING_MERGE_OBSERVATION_PATH,
      `${JSON.stringify(observation, null, 2)}\n`,
    );
    console.log(
      `[firestore-rules-sibling-merge] captured ${RULES_SIBLING_MERGE_OBSERVATION_PATH}`,
    );
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  await runLiveSiblingMergeCapture();
}
