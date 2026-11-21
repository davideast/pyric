#!/usr/bin/env bun
/**
 * Credentialed production capture for the `functions-callable` surface.
 *
 * Deploys the isolated `pyric-functions-callable-oracle` codebase (4 v2
 * `onCall` functions and 1 v1 `https.onCall` function) plus a 1-day Hosting
 * preview channel, provisions one run-scoped Firebase Auth user and one
 * run-scoped App Check debug token, captures all 15 wire probes and 7 Chromium
 * client probes, and deletes every deployed resource in a `finally` block.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
  type AppOptions,
} from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { requireCaptureMode } from '../../capture-mode-guard.ts';
import { resolvePackageVersion } from '../../package-version.ts';
import {
  deleteDebugToken,
  listRunTokens,
  registerDebugToken,
  sweepRunTokens,
  type RegisteredDebugToken,
} from '../app-check/debug-tokens.ts';
import {
  clearCaptureState,
  readCaptureState,
  resolveCaptureCredentials,
  resolveFirebaseTools,
  writeCaptureState,
  type CaptureState,
} from '../functions-http/deploy.ts';
import { sendProbe, sendProbeRequest, type ProbeTargets } from '../functions-http/send.ts';
import {
  openCallableBrowserSession,
  type CallableBrowserSession,
  type WebAppConfig,
} from './browser-runner.ts';
import { callableBody, type FunctionsCallableProbe } from './probe-types.ts';
import { functionsCallableProbes } from './probes.ts';
import {
  CALLABLE_CHANNEL_EXPIRES,
  CALLABLE_REGION,
  checkCallablePermissions,
  cleanUpCallableDeploy,
  deployCallableFixture,
  deployPreviewChannel,
  FIXTURE_FUNCTIONS,
  resolveWebConfig,
  runServiceUri,
} from './project-api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const CONFIG_PATH = join(HERE, 'firebase.json');
const FIXTURE_DIR = join(HERE, 'fixture');
const RUNTIME_PATH = join(FIXTURE_DIR, 'runtime.cjs');
const STATE_PATH = join(FIXTURE_DIR, 'capture-state.json');
const OBS_DIR = join(REPO_ROOT, 'packages', 'conformance', 'observations', 'functions-callable');

const rawArgs = process.argv.slice(2);
const checkOnly = rawArgs.includes('--check-permissions');
let cliArgs: string[] = rawArgs;
if (!checkOnly) {
  cliArgs = requireCaptureMode({
    label: 'functions-callable',
    scriptPath: 'packages/conformance/src/capture/functions-callable/harness.ts',
    argv: rawArgs,
    summary:
      'would deploy callable fixture functions + Hosting preview channel, create a run-scoped Auth user + App Check debug token, and capture 22 callable probes.',
    missingCredentials: () => {
      const resolved = resolveCaptureCredentials(process.env);
      if (resolved.ok) return null;
      return resolved.missing;
    },
  });
}

function ensureWorkspaceFirebaseTools(): void {
  const manifestPath = join(
    REPO_ROOT,
    'packages',
    'playground',
    'node_modules',
    'firebase-tools',
    'package.json',
  );
  if (existsSync(manifestPath)) return;
  const install = spawnSync('bun', ['install', '--frozen-lockfile', '--filter', '@pyric/playground'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    throw new Error('bun install --frozen-lockfile --filter @pyric/playground failed');
  }
}

function ensureFixtureInstalled(): void {
  if (existsSync(join(FIXTURE_DIR, 'node_modules', 'firebase-functions'))) return;
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: FIXTURE_DIR,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('npm ci in the callable fixture failed');
}

function writeObservation(
  probe: FunctionsCallableProbe,
  projectId: string,
  behavior: Record<string, unknown>,
): void {
  let rowIds = probe.rowIds;
  if (probe.pendingRowLink === true) {
    rowIds = [];
  }
  const observation = {
    name: probe.name,
    matrixRow: probe.matrixRow,
    rowIds,
    description: probe.description,
    observedAt: new Date().toISOString(),
    functionsSdkVersion: resolvePackageVersion('firebase-functions'),
    adminSdkVersion: resolvePackageVersion('firebase-admin'),
    fbSdkVersion: resolvePackageVersion('firebase'),
    projectId,
    behavior,
  };
  mkdirSync(OBS_DIR, { recursive: true });
  writeFileSync(
    join(OBS_DIR, `${observation.name}.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
  );
  console.log(`Captured ${observation.name}`);
}

async function waitForEcho(targets: ProbeTargets): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await sendProbeRequest(
      `${targets.functionBase(CALLABLE_REGION)}/pyricCallableEcho`,
      {
        id: 'warmup',
        function: 'pyricCallableEcho',
        via: 'cloudfunctions',
        ...callableBody({}),
      },
    );
    if (response.status === 200) return;
    await Bun.sleep(5_000);
  }
  throw new Error('pyricCallableEcho did not answer 200 within 180 s of deploy');
}

const credentialResolution = resolveCaptureCredentials(process.env);
if (!credentialResolution.ok) {
  throw new Error(
    `[functions-callable] missing required capture configuration: ${credentialResolution.missing}`,
  );
}
const captureCredentials = credentialResolution.config;
ensureWorkspaceFirebaseTools();
const firebaseTools = resolveFirebaseTools();

const projectId = captureCredentials.projectId;
const serviceAccountEmail = captureCredentials.clientEmail;
const keepDeployed = cliArgs.includes('--keep-deployed');

let adminOptions: AppOptions;
if (captureCredentials.kind === 'service-account-key') {
  adminOptions = { credential: cert(captureCredentials.credPath), projectId };
} else {
  adminOptions = {
    credential: applicationDefault(),
    projectId,
    serviceAccountId: serviceAccountEmail,
  };
}
const app = initializeApp(adminOptions, 'functions-callable-capture');
const accessToken = async (): Promise<string> => {
  const credential = app.options.credential;
  if (!credential) throw new Error('functions-callable-capture app has no credential');
  return (await credential.getAccessToken()).access_token;
};

const deployEnv: Record<string, string> = {};
if (captureCredentials.credPath !== undefined) {
  deployEnv.GOOGLE_APPLICATION_CREDENTIALS = captureCredentials.credPath;
}

if (checkOnly) {
  try {
    const missing = await checkCallablePermissions(await accessToken(), projectId);
    if (missing.length === 0) {
      console.log('All required permissions are granted.');
      process.exitCode = 0;
    } else {
      console.log(`${missing.length} permissions missing.`);
      process.exitCode = 1;
    }
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
} else {
  const leftover = readCaptureState(STATE_PATH);
  if (leftover) {
    console.log(
      `Run ${leftover.runId} (started ${leftover.startedAt}) never finished its cleanup; cleaning it up first.`,
    );
    const cleaned = await cleanUpCallableDeploy({
      firebaseTools,
      repoRoot: REPO_ROOT,
      state: leftover,
      env: deployEnv,
      deleteChannel: true,
      getToken: accessToken,
    });
    if (!cleaned) {
      await deleteApp(app).catch(() => undefined);
      throw new Error(
        `Run ${leftover.runId} still has fixture functions deployed; ${STATE_PATH} is kept for the next start.`,
      );
    }
    clearCaptureState(STATE_PATH);
  }

  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const state: CaptureState = {
    runId,
    channel: `pyric-fn-call-${runId}`,
    projectId,
    startedAt: new Date().toISOString(),
  };
  const testUid = `pyric-callable-oracle-${runId}`;
  let userCreated = false;
  let debugToken: RegisteredDebugToken | undefined;
  let webConfig: WebAppConfig | undefined;
  let browserSession: CallableBrowserSession | undefined;
  let deployAttempted = false;
  let channelAttempted = false;
  let completed = false;

  try {
    const initialToken = await accessToken();
    webConfig = await resolveWebConfig(initialToken, projectId);
    const authHeaders = {
      Authorization: `Bearer ${initialToken}`,
      'Content-Type': 'application/json',
    };
    await sweepRunTokens(authHeaders, projectId, webConfig.appId);
    debugToken = await registerDebugToken(authHeaders, projectId, webConfig.appId, runId);

    const adminAuth = getAuth(app);
    await adminAuth.createUser({
      uid: testUid,
      email: `${testUid}@example.test`,
      emailVerified: true,
    });
    userCreated = true;
    const customToken = await adminAuth.createCustomToken(testUid, { role: 'member' });

    ensureFixtureInstalled();
    writeFileSync(
      RUNTIME_PATH,
      `module.exports = { serviceAccount: ${JSON.stringify(serviceAccountEmail)} };\n`,
    );
    writeCaptureState(STATE_PATH, state);
    deployAttempted = true;
    await deployCallableFixture({
      firebaseTools,
      repoRoot: REPO_ROOT,
      configPath: CONFIG_PATH,
      projectId,
      env: deployEnv,
      getToken: accessToken,
    });
    channelAttempted = true;
    const hostingBase = await deployPreviewChannel({
      firebaseTools,
      repoRoot: REPO_ROOT,
      configPath: CONFIG_PATH,
      channel: state.channel,
      projectId,
      env: deployEnv,
    });
    console.log(`Hosting channel ${state.channel} deployed (expires in ${CALLABLE_CHANNEL_EXPIRES}).`);

    const freshToken = await accessToken();
    const runUris = new Map<string, string>();
    for (const fn of FIXTURE_FUNCTIONS.filter((candidate) => candidate.platform === 'gcfv2')) {
      runUris.set(fn.name, await runServiceUri(freshToken, projectId, fn));
    }
    const echoRunUri = runUris.get('pyricCallableEcho');
    if (!echoRunUri) throw new Error('pyricCallableEcho has no Cloud Run URI');

    const targets: ProbeTargets = {
      functionBase: (region) => `https://${region}-${projectId}.cloudfunctions.net`,
      runBase: (name) => {
        const uri = runUris.get(name);
        if (!uri) throw new Error(`${name} has no run.app URL`);
        return uri;
      },
      hostingBase: () => hostingBase,
    };
    await waitForEcho(targets);

    browserSession = await openCallableBrowserSession({
      repoRoot: REPO_ROOT,
      hostingBase,
      webConfig,
      debugToken: debugToken.value,
      customToken,
    });

    for (const probe of functionsCallableProbes) {
      if (probe.kind === 'wire') {
        const requests = await browserSession.withWireTokens(probe.requests);
        const responses = await sendProbe(requests, targets);
        writeObservation(probe, projectId, probe.behavior(responses));
      } else {
        let probeCustomToken: string | undefined;
        if (probe.scenario === 'signedIn') {
          probeCustomToken = customToken;
        }
        const facts = await browserSession.runClientProbe(probe, {
          region: CALLABLE_REGION,
          urls: {
            cloudfunctions: `https://${CALLABLE_REGION}-${projectId}.cloudfunctions.net/pyricCallableEcho`,
            run: echoRunUri,
          },
          customDomain: hostingBase,
          customToken: probeCustomToken,
        });
        writeObservation(probe, projectId, probe.behavior(facts));
      }
    }
    completed = true;
  } finally {
    await browserSession?.close();
    if (existsSync(RUNTIME_PATH)) unlinkSync(RUNTIME_PATH);
    if (userCreated) {
      await getAuth(app).deleteUser(testUid).catch((err: unknown) => {
        console.error(`Cleanup could not delete user ${testUid}: ${String(err)}`);
      });
    }
    if (debugToken && webConfig) {
      try {
        const cleanupHeaders = {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        };
        await deleteDebugToken(cleanupHeaders, debugToken.name);
        const remainingTokens = await listRunTokens(cleanupHeaders, projectId, webConfig.appId);
        console.log(`Deleted debug token; run-scoped tokens remaining: ${remainingTokens.length}`);
      } catch (err: unknown) {
        console.error(`Cleanup could not delete debug token: ${String(err)}`);
      }
    }
    const keptDeployed = keepDeployed && deployAttempted;
    if (keptDeployed) {
      console.log(
        `--keep-deployed: run ${runId} stays deployed, and ${STATE_PATH} makes the next start clean it up.`,
      );
    } else if (deployAttempted) {
      const cleaned = await cleanUpCallableDeploy({
        firebaseTools,
        repoRoot: REPO_ROOT,
        state,
        env: deployEnv,
        deleteChannel: channelAttempted,
        getToken: accessToken,
      });
      if (cleaned) clearCaptureState(STATE_PATH);
      else {
        console.error(
          `Fixture functions remain; ${STATE_PATH} is kept so the next start cleans up run ${runId}.`,
        );
      }
    }
    await deleteApp(app).catch(() => undefined);
    if (!completed) console.error(`Capture failed for run ${runId}; cleanup was attempted.`);
  }
}
