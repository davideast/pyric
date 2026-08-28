#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePackageVersion } from '../../package-version.ts';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { probe as exactProbe } from '../../../probes/functions-rtdb/functions-rtdb-onvaluecreated-exact-create.ts';
import { probe as startupProbe } from '../../../probes/functions-rtdb/functions-rtdb-onvaluecreated-startup-existing.ts';
import { probe as wildcardProbe } from '../../../probes/functions-rtdb/functions-rtdb-onvaluecreated-wildcard-batches.ts';
import { probe as descendantProbe } from '../../../probes/functions-rtdb/functions-rtdb-onvaluecreated-descendant-projection.ts';
import { probe as failureProbe } from '../../../probes/functions-rtdb/functions-rtdb-onvaluecreated-failed-execution.ts';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

interface CaptureState {
  runId: string;
  deployedAt: string;
}

interface LogCapture {
  scenario: string;
  runId: string;
  event: Record<string, any>;
  snapshot: Record<string, any>;
  handler?: Record<string, any>;
  loggingTimestamp?: string;
}

interface FailureOutcome {
  matchingRuntimeErrorCount: number;
  requestStatuses: number[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const CONFIG_PATH = join(HERE, 'firebase.json');
const FIXTURE_DIR = join(HERE, 'fixture');
const RUNTIME_PATH = join(FIXTURE_DIR, 'runtime.cjs');
const STATE_PATH = join(FIXTURE_DIR, 'capture-state.json');
const OBS_DIR = join(REPO_ROOT, 'packages', 'conformance', 'observations', 'functions-rtdb');
const CODEBASE = 'pyric-functions-rtdb-oracle';
const FUNCTION_NAMES = [
  'pyricRtdbExactCreate',
  'pyricRtdbWildcardCreate',
  'pyricRtdbDescendantCreate',
  'pyricRtdbStartupCreate',
  'pyricRtdbExpectedFailure',
];
const REGION = process.env.PYRIC_FUNCTIONS_RTDB_REGION ?? 'us-central1';
const NEGATIVE_WINDOW_MS = 15_000;

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function packageVersion(specifier: string): string {
  return resolvePackageVersion(specifier);
}

function firebase(args: string[], env: Record<string, string>): void {
  const result = spawnSync('firebase', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`firebase ${args.join(' ')} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`firebase ${args.join(' ')} exited ${result.status}`);
}

async function loggingEntries(
  projectId: string,
  token: string,
  filter: string,
  orderBy = 'timestamp asc',
): Promise<Record<string, any>[]> {
  const response = await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resourceNames: [`projects/${projectId}`],
      filter,
      orderBy,
      pageSize: 1000,
    }),
  });
  if (!response.ok) throw new Error(`Logging entries:list failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { entries?: Record<string, any>[] };
  return body.entries ?? [];
}

async function listCaptures(projectId: string, token: string, runId: string): Promise<LogCapture[]> {
  const entries = await loggingEntries(
    projectId,
    token,
    `jsonPayload.pyricFunctionsRtdb.runId="${runId}"`,
  );
  return entries.flatMap((entry) => {
    const payload = entry.jsonPayload?.pyricFunctionsRtdb as LogCapture | undefined;
    return payload ? [{ ...payload, loggingTimestamp: entry.timestamp }] : [];
  });
}

async function listRecoverableCaptures(
  projectId: string,
  token: string,
  runId: string,
  deployedAt: string,
): Promise<LogCapture[]> {
  const entries = await loggingEntries(
    projectId,
    token,
    `resource.type="cloud_run_revision" AND timestamp>="${deployedAt}" AND jsonPayload.pyricFunctionsRtdb:*`,
  );
  return entries.flatMap((entry) => {
    const payload = entry.jsonPayload?.pyricFunctionsRtdb as LogCapture | undefined;
    return payload?.runId === runId ? [{ ...payload, loggingTimestamp: entry.timestamp }] : [];
  });
}

async function waitForScenarioCount(
  projectId: string,
  token: string,
  runId: string,
  scenario: string,
  count: number,
): Promise<LogCapture[]> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const captures = (await listCaptures(projectId, token, runId)).filter(
      (capture) => capture.scenario === scenario,
    );
    if (captures.length >= count) return captures;
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${count} ${scenario} captures for ${runId}`);
}

async function failureOutcome(
  projectId: string,
  token: string,
  deployedAt: string,
): Promise<FailureOutcome> {
  const entries = await loggingEntries(
    projectId,
    token,
    `resource.type="cloud_run_revision" AND resource.labels.service_name="pyricrtdbexpectedfailure" AND timestamp>="${deployedAt}"`,
  );
  return {
    matchingRuntimeErrorCount: entries.filter((entry) =>
      JSON.stringify(entry).includes(failureProbe.errorMarker),
    ).length,
    requestStatuses: entries.flatMap((entry) =>
      typeof entry.httpRequest?.status === 'number' ? [entry.httpRequest.status] : [],
    ),
  };
}

async function waitForFailureOutcome(
  projectId: string,
  token: string,
  deployedAt: string,
): Promise<FailureOutcome> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const outcome = await failureOutcome(projectId, token, deployedAt);
    if (outcome.matchingRuntimeErrorCount > 0) return outcome;
    await Bun.sleep(2_000);
  }
  return { matchingRuntimeErrorCount: 0, requestStatuses: [] };
}

function writeObservation(
  probe: { name: string; matrixRow: string; rowIds: string[]; description: string },
  projectId: string,
  behavior: Record<string, unknown>,
): void {
  const observation = {
    name: probe.name,
    matrixRow: probe.matrixRow,
    rowIds: probe.rowIds,
    description: probe.description,
    observedAt: new Date().toISOString(),
    functionsSdkVersion: packageVersion('firebase-functions'),
    adminSdkVersion: packageVersion('firebase-admin'),
    projectId,
    behavior,
  };
  mkdirSync(OBS_DIR, { recursive: true });
  const output = join(OBS_DIR, `${observation.name}.json`);
  writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`Captured ${output}`);
}

const saPath = need('PYRIC_FUNCTIONS_RTDB_SA_PATH');
if (!existsSync(saPath)) throw new Error(`Service account not found: ${saPath}`);
const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount;
const projectId = serviceAccount.project_id;
const databaseUrl =
  process.env.PYRIC_FUNCTIONS_RTDB_DATABASE_URL ?? `https://${projectId}-default-rtdb.firebaseio.com`;
const instance = new URL(databaseUrl).hostname.split('.')[0];
const deployOnly = process.argv.includes('--deploy-only');
const skipDeploy = process.argv.includes('--skip-deploy');
const keepDeployed = process.argv.includes('--keep-deployed');
const recoverRunId = process.env.PYRIC_FUNCTIONS_RTDB_RECOVER_RUN_ID?.trim();
const recoverDeployedAt = process.env.PYRIC_FUNCTIONS_RTDB_RECOVER_DEPLOYED_AT?.trim();
if ([deployOnly, skipDeploy, Boolean(recoverRunId)].filter(Boolean).length > 1) {
  throw new Error('--deploy-only, --skip-deploy, and recovery mode are mutually exclusive');
}
if (recoverRunId && !recoverDeployedAt) {
  throw new Error('PYRIC_FUNCTIONS_RTDB_RECOVER_DEPLOYED_AT is required in recovery mode');
}

const existingState = skipDeploy
  ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as CaptureState)
  : null;
const state: CaptureState =
  existingState ??
  (recoverRunId
    ? { runId: recoverRunId, deployedAt: recoverDeployedAt! }
    : {
        runId: `pyric-${Date.now()}-${randomUUID().slice(0, 8)}`,
        deployedAt: new Date().toISOString(),
      });
const basePath = `/pyric_oracle/functions/${state.runId}`;
const deployEnv = {
  GOOGLE_APPLICATION_CREDENTIALS: saPath,
  PYRIC_FUNCTIONS_RTDB_INSTANCE: instance,
  PYRIC_FUNCTIONS_RTDB_REGION: REGION,
};
const adminServiceAccount = {
  projectId: serviceAccount.project_id,
  clientEmail: serviceAccount.client_email,
  privateKey: serviceAccount.private_key,
};

const app = initializeApp({ credential: cert(adminServiceAccount), databaseURL: databaseUrl });
const database = getDatabase(app);
let deployed = skipDeploy;
let completed = false;

if (recoverRunId) {
  try {
    const access = await app.options.credential!.getAccessToken();
    const token = access.access_token;
    const allCaptures = await listRecoverableCaptures(
      projectId,
      token,
      state.runId,
      state.deployedAt,
    );
    const exactCaptures = allCaptures.filter((capture) => capture.scenario === 'exact-lifecycle');
    const startupCaptures = allCaptures.filter((capture) => capture.scenario === 'startup-existing');
    const wildcardCaptures = allCaptures.filter((capture) => capture.scenario === 'wildcard-batches');
    const descendantCaptures = allCaptures.filter(
      (capture) => capture.scenario === 'descendant-projection',
    );
    const failureCaptures = allCaptures.filter((capture) => capture.scenario === 'failed-execution');
    const expected = [
      ['exact-lifecycle', exactCaptures.length, 1],
      ['startup-existing', startupCaptures.length, 0],
      ['wildcard-batches', wildcardCaptures.length, 8],
      ['descendant-projection', descendantCaptures.length, 1],
      ['failed-execution', failureCaptures.length, 1],
    ] as const;
    for (const [scenario, actual, count] of expected) {
      if (actual !== count) {
        throw new Error(`Recovery expected ${count} ${scenario} logs, found ${actual}`);
      }
    }
    const recoveredFailure = await failureOutcome(projectId, token, state.deployedAt);
    if (recoveredFailure.matchingRuntimeErrorCount === 0) {
      throw new Error('Recovery found no managed runtime error containing the failure marker');
    }
    const handlerWrite = exactCaptures[0].handler?.adminWriteCompleted
      ? { completed: true, sourceKey: exactCaptures[0].handler?.adminRefKey }
      : null;
    writeObservation(exactProbe, projectId, exactProbe.behavior(exactCaptures, handlerWrite));
    writeObservation(
      startupProbe,
      projectId,
      startupProbe.behavior(0, startupProbe.inputValue, NEGATIVE_WINDOW_MS),
    );
    writeObservation(wildcardProbe, projectId, wildcardProbe.behavior(wildcardCaptures));
    writeObservation(
      descendantProbe,
      projectId,
      descendantProbe.behavior(descendantCaptures[0]),
    );
    writeObservation(
      failureProbe,
      projectId,
      failureProbe.behavior(failureCaptures.length, recoveredFailure),
    );
  } finally {
    await database.ref(basePath).remove().catch(() => undefined);
    if (!keepDeployed) {
      try {
        firebase(
          [
            'functions:delete',
            ...FUNCTION_NAMES,
            '--region',
            REGION,
            '--project',
            projectId,
            '--force',
            '--non-interactive',
          ],
          deployEnv,
        );
      } catch (error) {
        console.error(
          `Recovery cleanup could not delete fixture functions: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await deleteApp(app).catch(() => undefined);
  }
  process.exit(0);
}

let deployAttempted = false;
try {
  if (!skipDeploy) {
    await database.ref(startupProbe.inputPath(state.runId)).set(startupProbe.inputValue);
    writeFileSync(RUNTIME_PATH, `module.exports = { serviceAccount: ${JSON.stringify(serviceAccount.client_email)} };\n`);
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
    deployAttempted = true;
    firebase(
      [
        'deploy',
        '--config',
        CONFIG_PATH,
        '--project',
        projectId,
        '--only',
        `functions:${CODEBASE}`,
        '--force',
        '--non-interactive',
      ],
      deployEnv,
    );
    deployed = true;
  }

  if (deployOnly) {
    console.log(`Deployed ${FUNCTION_NAMES.join(', ')} for run ${state.runId}.`);
    console.log('Run again with --skip-deploy to capture and clean up.');
  } else {
    await Bun.sleep(skipDeploy ? 20_000 : 30_000);
    const access = await app.options.credential!.getAccessToken();
    const token = access.access_token;

    await database.ref(exactProbe.inputPath(state.runId)).set(exactProbe.inputValue);
    await waitForScenarioCount(projectId, token, state.runId, 'exact-lifecycle', 1);
    await database.ref(exactProbe.inputPath(state.runId)).update({ count: 2 });
    await database.ref(exactProbe.inputPath(state.runId)).remove();

    const wildcardRoot = database.ref(wildcardProbe.rootPath(state.runId));
    await wildcardRoot.child('single').set(wildcardProbe.cases.single);
    await waitForScenarioCount(projectId, token, state.runId, 'wildcard-batches', 1);
    await wildcardRoot.child('fanout').set(wildcardProbe.cases.fanout);
    await waitForScenarioCount(projectId, token, state.runId, 'wildcard-batches', 3);
    await wildcardRoot.child('multipath').update(wildcardProbe.cases.multipath);
    await waitForScenarioCount(projectId, token, state.runId, 'wildcard-batches', 5);
    for (const sequence of wildcardProbe.cases.ordering) {
      await wildcardRoot.child(`ordering/item-${sequence}`).set({ sequence });
    }
    const wildcardCaptures = await waitForScenarioCount(
      projectId,
      token,
      state.runId,
      'wildcard-batches',
      8,
    );

    await database.ref(descendantProbe.ancestorPath(state.runId)).set(descendantProbe.inputValue);
    const descendantCapture = (
      await waitForScenarioCount(projectId, token, state.runId, 'descendant-projection', 1)
    )[0];

    await database.ref(failureProbe.inputPath(state.runId)).set(failureProbe.inputValue);
    const failureCaptures = await waitForScenarioCount(
      projectId,
      token,
      state.runId,
      'failed-execution',
      1,
    );
    const runtimeFailure = await waitForFailureOutcome(projectId, token, state.deployedAt);

    await Bun.sleep(NEGATIVE_WINDOW_MS);
    const allCaptures = await listCaptures(projectId, token, state.runId);
    const exactCaptures = allCaptures.filter((capture) => capture.scenario === 'exact-lifecycle');
    const startupCaptures = allCaptures.filter((capture) => capture.scenario === 'startup-existing');
    const handlerWrite = await database.ref(`${basePath}/exact/handler-write`).get();
    const startupValue = await database.ref(startupProbe.inputPath(state.runId)).get();

    writeObservation(
      exactProbe,
      projectId,
      exactProbe.behavior(exactCaptures, handlerWrite.val()),
    );
    writeObservation(
      startupProbe,
      projectId,
      startupProbe.behavior(startupCaptures.length, startupValue.val(), NEGATIVE_WINDOW_MS),
    );
    writeObservation(wildcardProbe, projectId, wildcardProbe.behavior(wildcardCaptures));
    writeObservation(
      descendantProbe,
      projectId,
      descendantProbe.behavior(descendantCapture),
    );
    writeObservation(
      failureProbe,
      projectId,
      failureProbe.behavior(failureCaptures.length, runtimeFailure),
    );
    completed = true;
  }
} finally {
  if (deployOnly && !deployed) {
    await database.ref(basePath).remove().catch(() => undefined);
  }
  await deleteApp(app).catch(() => undefined);
  if (!deployOnly) {
    const cleanupApp = initializeApp(
      { credential: cert(adminServiceAccount), databaseURL: databaseUrl },
      'functions-rtdb-cleanup',
    );
    await getDatabase(cleanupApp).ref(basePath).remove().catch(() => undefined);
    await deleteApp(cleanupApp).catch(() => undefined);
    if ((deployed || deployAttempted) && !keepDeployed) {
      try {
        firebase(
          [
            'functions:delete',
            ...FUNCTION_NAMES,
            '--region',
            REGION,
            '--project',
            projectId,
            '--force',
            '--non-interactive',
          ],
          deployEnv,
        );
      } catch (error) {
        console.error(
          `Cleanup could not delete fixture functions: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    if (existsSync(RUNTIME_PATH)) unlinkSync(RUNTIME_PATH);
  } else if (!deployed) {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    if (existsSync(RUNTIME_PATH)) unlinkSync(RUNTIME_PATH);
  }
  if (!deployOnly && !completed) {
    console.error(`Capture failed for run ${state.runId}; cleanup was attempted.`);
  }
}
