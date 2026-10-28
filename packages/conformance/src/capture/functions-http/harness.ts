#!/usr/bin/env bun
/**
 * Credentialed capture for the functions-http surface.
 *
 *   PYRIC_ORACLE_SA_PATH=<deployer key> bun packages/conformance/src/capture/functions-http/harness.ts --check-permissions
 *   PYRIC_ORACLE_SA_PATH=<deployer key> bun packages/conformance/src/capture/functions-http/harness.ts
 *
 * Deploys the fixture codebase (11 v2 functions and 1 v1 function) and a
 * Hosting preview channel that expires after a day, sends every probe's
 * requests to production, freezes one observation per probe, and then, in a
 * `finally`, deletes the channel, the functions, and their Artifact Registry
 * images. `--keep-deployed` skips the deletion; `--check-permissions` only
 * tests the deployer's IAM permissions and changes nothing.
 *
 * It runs the workspace's firebase-tools 15.23.0, never `firebase` from PATH.
 * The deploy runs without `--force`, so firebase-tools sets no Artifact
 * Registry cleanup policy. A region with none makes it exit 1 after every
 * function deployed, and the harness reads exactly that error as deployed.
 * Before deploying it records the run in `fixture/capture-state.json`; a run
 * that never reaches its cleanup leaves the file, and the next start deletes
 * that run's channel, functions, and images before doing anything else.
 *
 * Nothing secret is printed: the key file is read for its project id and
 * client email only, access tokens never leave request headers, and run.app
 * URLs are logged by shape.
 */
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { resolvePackageVersion } from '../../package-version.ts';
import { functionsHttpProbes } from './probes.ts';
import type { FunctionsHttpProbe } from './probe-types.ts';
import { sendProbe, sendProbeRequest, type ProbeTargets } from './send.ts';
import {
  clearCaptureState,
  deployOutcome,
  readCaptureState,
  resolveFirebaseTools,
  writeCaptureState,
  type CaptureState,
} from './deploy.ts';

interface ServiceAccount {
  project_id: string;
  client_email: string;
}

interface FixtureFunction {
  name: string;
  region: string;
  platform: 'gcfv1' | 'gcfv2';
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const CONFIG_PATH = join(HERE, 'firebase.json');
const FIXTURE_DIR = join(HERE, 'fixture');
const RUNTIME_PATH = join(FIXTURE_DIR, 'runtime.cjs');
const STATE_PATH = join(FIXTURE_DIR, 'capture-state.json');
const OBS_DIR = join(REPO_ROOT, 'packages', 'conformance', 'observations', 'functions-http');
const CODEBASE = 'pyric-functions-http-oracle';
const CHANNEL_EXPIRES = '1d';

/** Every function the fixture exports, as the deploy creates it. */
const FIXTURE_FUNCTIONS: readonly FixtureFunction[] = [
  { name: 'pyricHttpEcho', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpRegional', region: 'us-east1', platform: 'gcfv2' },
  { name: 'pyricHttpPrivate', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpCorsTrue', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpCorsList', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpCorsRegex', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpV1', region: 'us-central1', platform: 'gcfv1' },
  { name: 'pyricHttpResponses', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpThrow', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpThrowAfterHeaders', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpTimeout', region: 'us-central1', platform: 'gcfv2' },
  { name: 'pyricHttpUncaught', region: 'us-central1', platform: 'gcfv2' },
];

/** The IAM permissions a full run needs, by the role the rig manifest names for them. */
const REQUIRED_PERMISSIONS: Record<string, readonly string[]> = {
  'Cloud Functions Developer': [
    'cloudfunctions.functions.create',
    'cloudfunctions.functions.delete',
    'cloudfunctions.functions.get',
    'cloudfunctions.functions.list',
    'cloudfunctions.functions.update',
    'cloudfunctions.functions.sourceCodeSet',
    'cloudfunctions.operations.get',
  ],
  'Service Account User': ['iam.serviceAccounts.actAs'],
  'Cloud Run Admin': ['run.services.get', 'run.services.getIamPolicy', 'run.services.setIamPolicy'],
  'Firebase Hosting Admin': [
    'firebasehosting.sites.get',
    'firebasehosting.sites.update',
  ],
  'Logs Viewer': ['logging.logEntries.list'],
  'Artifact Registry cleanup (images)': [
    'artifactregistry.packages.list',
    'artifactregistry.packages.delete',
  ],
  'Firebase CLI project reads': [
    'firebase.projects.get',
    'resourcemanager.projects.get',
    'serviceusage.services.get',
  ],
};

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const firebaseTools = resolveFirebaseTools();

interface FirebaseRun {
  status: number | null;
  /** What firebase-tools wrote to stdout; its logger writes errors there too. */
  stdout: string;
  /** stdout and stderr together, in arrival order. */
  output: string;
}

/** Runs the pinned firebase-tools, passing its output through as it arrives. */
function runFirebase(args: string[], env: Record<string, string>): Promise<FirebaseRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [firebaseTools.bin, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      process.stdout.write(chunk);
      stdout += chunk;
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      process.stderr.write(chunk);
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (signal) reject(new Error(`firebase ${args[0]} terminated by ${signal}`));
      else resolvePromise({ status, stdout, output });
    });
  });
}

async function firebase(args: string[], env: Record<string, string>): Promise<string> {
  const result = await runFirebase(args, env);
  if (result.status !== 0) throw new Error(`firebase ${args[0]} exited ${result.status}`);
  return result.stdout;
}

/** Deploys the fixture codebase; a region left without a cleanup policy still counts as deployed. */
async function deployFixture(projectId: string, env: Record<string, string>): Promise<void> {
  const result = await runFirebase(
    ['deploy', '--config', CONFIG_PATH, '--project', projectId, '--only', `functions:${CODEBASE}`, '--non-interactive'],
    env,
  );
  const outcome = deployOutcome(result.status, result.output);
  if (outcome === 'failed') throw new Error(`firebase deploy exited ${result.status}`);
  if (outcome === 'deployed-without-cleanup-policy') {
    console.log('Functions deployed. No cleanup policy was set; this run deletes its own images.');
  }
}

async function googleApi(token: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} failed: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Reads the project's IAM grant for every required permission; changes nothing. */
async function checkPermissions(token: string, projectId: string): Promise<string[]> {
  const permissions = [...new Set(Object.values(REQUIRED_PERMISSIONS).flat())];
  const result = await googleApi(
    token,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
    { method: 'POST', body: JSON.stringify({ permissions }) },
  ) as { permissions?: string[] };
  const granted = new Set(result.permissions ?? []);
  const missing: string[] = [];
  for (const [role, needed] of Object.entries(REQUIRED_PERMISSIONS)) {
    const absent = needed.filter((permission) => !granted.has(permission));
    console.log(`${absent.length === 0 ? 'ok     ' : 'missing'} ${role}${absent.length ? `: ${absent.join(', ')}` : ''}`);
    missing.push(...absent);
  }
  return missing;
}

async function runServiceUri(token: string, projectId: string, fn: FixtureFunction): Promise<string> {
  const body = await googleApi(
    token,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${fn.region}/functions/${fn.name}`,
  ) as { serviceConfig?: { uri?: string } };
  const uri = body.serviceConfig?.uri;
  if (!uri) throw new Error(`${fn.name} has no Cloud Run URI`);
  console.log(`${fn.name}: run URL https://${fn.name.toLowerCase()}-<hash>-<rc>.a.run.app`);
  return uri.replace(/\/$/, '');
}

async function deployChannel(channel: string, projectId: string, env: Record<string, string>): Promise<string> {
  const output = await firebase(
    ['hosting:channel:deploy', channel, '--expires', CHANNEL_EXPIRES, '--config', CONFIG_PATH, '--project', projectId, '--json', '--non-interactive'],
    env,
  );
  const parsed = JSON.parse(output) as { result?: Record<string, { url?: string }> };
  const url = Object.values(parsed.result ?? {})[0]?.url;
  if (!url) throw new Error('hosting:channel:deploy returned no channel URL');
  return url.replace(/\/$/, '');
}

/** Deletes the build images the deploy left in each region's gcf-artifacts repository. */
async function deleteImages(token: string, projectId: string): Promise<string[]> {
  const deleted: string[] = [];
  const regions = [...new Set(FIXTURE_FUNCTIONS.map((fn) => fn.region))];
  const suffixes = FIXTURE_FUNCTIONS.map((fn) => fn.name.toLowerCase());
  for (const region of regions) {
    const base = `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${region}/repositories/gcf-artifacts/packages`;
    let listed: { packages?: Array<{ name: string }> };
    try {
      listed = await googleApi(token, `${base}?pageSize=1000`) as typeof listed;
    } catch (error) {
      console.error(`Could not list images in ${region}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const { name } of listed.packages ?? []) {
      const packageId = decodeURIComponent(name.split('/').pop() ?? '');
      const normalized = packageId.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!suffixes.some((suffix) => normalized.endsWith(suffix))) continue;
      try {
        await googleApi(token, `https://artifactregistry.googleapis.com/v1/${name}`, { method: 'DELETE' });
        deleted.push(`${region}/${packageId}`);
      } catch (error) {
        console.error(`Could not delete image ${packageId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return deleted;
}

/** The fixture functions still deployed, read back after cleanup. */
async function remainingFunctions(token: string, projectId: string): Promise<string[]> {
  const body = await googleApi(
    token,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/-/functions?pageSize=1000`,
  ) as { functions?: Array<{ name: string }> };
  const names = new Set(FIXTURE_FUNCTIONS.map((fn) => fn.name));
  return (body.functions ?? []).map((fn) => fn.name.split('/').pop() ?? '').filter((name) => names.has(name));
}

function writeObservation(probe: FunctionsHttpProbe, projectId: string, behavior: Record<string, unknown>): void {
  const observation = {
    name: probe.name,
    matrixRow: probe.matrixRow,
    rowIds: probe.rowIds,
    description: probe.description,
    observedAt: new Date().toISOString(),
    functionsSdkVersion: resolvePackageVersion('firebase-functions'),
    adminSdkVersion: resolvePackageVersion('firebase-admin'),
    projectId,
    behavior,
  };
  mkdirSync(OBS_DIR, { recursive: true });
  const output = join(OBS_DIR, `${observation.name}.json`);
  writeFileSync(output, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`Captured ${observation.name}`);
}

async function waitForEcho(targets: ProbeTargets): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await sendProbeRequest(`${targets.functionBase('us-central1')}/pyricHttpEcho`, {
      id: 'warmup',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
    });
    if (response.status === 200) return;
    await Bun.sleep(5_000);
  }
  throw new Error('pyricHttpEcho did not answer 200 within 180 s of deploy');
}

function ensureFixtureInstalled(): void {
  if (existsSync(join(FIXTURE_DIR, 'node_modules', 'firebase-functions'))) return;
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: FIXTURE_DIR, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('npm ci in the fixture failed');
}

/**
 * Deletes one run's channel, every fixture function, and their images, then
 * reads back what remains. True when no fixture function is left deployed.
 */
async function cleanUp(state: CaptureState, env: Record<string, string>, deleteChannel: boolean): Promise<boolean> {
  if (deleteChannel) {
    try {
      await firebase(['hosting:channel:delete', state.channel, '--project', state.projectId, '--force', '--non-interactive'], env);
      console.log(`Deleted hosting channel ${state.channel}.`);
    } catch (error) {
      console.error(`Cleanup could not delete channel ${state.channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const region of [...new Set(FIXTURE_FUNCTIONS.map((fn) => fn.region))]) {
    const names = FIXTURE_FUNCTIONS.filter((fn) => fn.region === region).map((fn) => fn.name);
    try {
      await firebase(['functions:delete', ...names, '--region', region, '--project', state.projectId, '--force', '--non-interactive'], env);
    } catch (error) {
      console.error(`Cleanup could not delete functions in ${region}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const token = await accessToken();
    const images = await deleteImages(token, state.projectId);
    console.log(`Deleted ${images.length} images: ${images.join(', ') || 'none'}`);
    const remaining = await remainingFunctions(token, state.projectId);
    console.log(remaining.length === 0 ? 'No fixture functions remain.' : `Fixture functions still deployed: ${remaining.join(', ')}`);
    return remaining.length === 0;
  } catch (error) {
    console.error(`Cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const saPath = need('PYRIC_ORACLE_SA_PATH');
if (!existsSync(saPath)) throw new Error('PYRIC_ORACLE_SA_PATH does not name a file');
const serviceAccountJson = JSON.parse(readFileSync(saPath, 'utf8')) as ServiceAccount & Record<string, string>;
const projectId = serviceAccountJson.project_id;
const keepDeployed = process.argv.includes('--keep-deployed');
const checkOnly = process.argv.includes('--check-permissions');

const app = initializeApp({ credential: cert(saPath) }, 'functions-http-capture');
const accessToken = async (): Promise<string> => (await app.options.credential!.getAccessToken()).access_token;

if (checkOnly) {
  try {
    const missing = await checkPermissions(await accessToken(), projectId);
    console.log(missing.length === 0 ? 'All required permissions are granted.' : `${missing.length} permissions missing.`);
    process.exitCode = missing.length === 0 ? 0 : 1;
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
} else {
  const deployEnv = { GOOGLE_APPLICATION_CREDENTIALS: saPath };
  const leftover = readCaptureState(STATE_PATH);
  if (leftover) {
    console.log(`Run ${leftover.runId} (started ${leftover.startedAt}) never finished its cleanup; cleaning it up first.`);
    const cleaned = await cleanUp(leftover, deployEnv, true);
    if (!cleaned) {
      await deleteApp(app).catch(() => undefined);
      throw new Error(`Run ${leftover.runId} still has fixture functions deployed; ${STATE_PATH} is kept for the next start.`);
    }
    clearCaptureState(STATE_PATH);
  }

  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const state: CaptureState = { runId, channel: `pyric-fn-http-${runId}`, projectId, startedAt: new Date().toISOString() };
  let deployAttempted = false;
  let channelAttempted = false;
  let completed = false;
  try {
    ensureFixtureInstalled();
    writeFileSync(RUNTIME_PATH, `module.exports = { serviceAccount: ${JSON.stringify(serviceAccountJson.client_email)} };\n`);
    writeCaptureState(STATE_PATH, state);
    deployAttempted = true;
    await deployFixture(projectId, deployEnv);
    channelAttempted = true;
    const hostingBase = await deployChannel(state.channel, projectId, deployEnv);
    console.log(`Hosting channel ${state.channel} deployed (expires in ${CHANNEL_EXPIRES}).`);

    const token = await accessToken();
    const runUris = new Map<string, string>();
    for (const fn of FIXTURE_FUNCTIONS.filter((candidate) => candidate.platform === 'gcfv2')) {
      runUris.set(fn.name, await runServiceUri(token, projectId, fn));
    }
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

    for (const probe of functionsHttpProbes) {
      const responses = await sendProbe(probe.requests, targets);
      writeObservation(probe, projectId, probe.behavior(responses));
    }
    completed = true;
  } finally {
    if (existsSync(RUNTIME_PATH)) unlinkSync(RUNTIME_PATH);
    const keptDeployed = keepDeployed && deployAttempted;
    if (keptDeployed) {
      console.log(`--keep-deployed: run ${runId} stays deployed, and ${STATE_PATH} makes the next start clean it up.`);
    } else if (deployAttempted) {
      const cleaned = await cleanUp(state, deployEnv, channelAttempted);
      if (cleaned) clearCaptureState(STATE_PATH);
      else console.error(`Fixture functions remain; ${STATE_PATH} is kept so the next start cleans up run ${runId}.`);
    }
    await deleteApp(app).catch(() => undefined);
    if (!completed) console.error(`Capture failed for run ${runId}; cleanup was attempted.`);
  }
}
