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
 * Nothing secret is printed: the key file is read for its project id and
 * client email only, access tokens never leave request headers, and run.app
 * URLs are logged by shape.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { resolvePackageVersion } from '../../package-version.ts';
import { functionsHttpProbes } from './probes.ts';
import type { FunctionsHttpProbe } from './probe-types.ts';
import { sendProbe, sendProbeRequest, type ProbeTargets } from './send.ts';

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

function firebase(args: string[], env: Record<string, string>, capture = false): string {
  const result = spawnSync('firebase', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`firebase ${args[0]} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`firebase ${args[0]} exited ${result.status}`);
  return capture ? result.stdout : '';
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

function deployChannel(channel: string, projectId: string, env: Record<string, string>): string {
  const output = firebase(
    ['hosting:channel:deploy', channel, '--expires', CHANNEL_EXPIRES, '--config', CONFIG_PATH, '--project', projectId, '--json', '--non-interactive'],
    env,
    true,
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
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  const channel = `pyric-fn-http-${runId}`;
  const deployEnv = { GOOGLE_APPLICATION_CREDENTIALS: saPath };
  let deployAttempted = false;
  let channelAttempted = false;
  let completed = false;
  try {
    ensureFixtureInstalled();
    writeFileSync(RUNTIME_PATH, `module.exports = { serviceAccount: ${JSON.stringify(serviceAccountJson.client_email)} };\n`);
    deployAttempted = true;
    firebase(
      ['deploy', '--config', CONFIG_PATH, '--project', projectId, '--only', `functions:${CODEBASE}`, '--non-interactive'],
      deployEnv,
    );
    channelAttempted = true;
    const hostingBase = deployChannel(channel, projectId, deployEnv);
    console.log(`Hosting channel ${channel} deployed (expires in ${CHANNEL_EXPIRES}).`);

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
    if (!keepDeployed) {
      if (channelAttempted) {
        try {
          firebase(['hosting:channel:delete', channel, '--project', projectId, '--force', '--non-interactive'], deployEnv);
          console.log(`Deleted hosting channel ${channel}.`);
        } catch (error) {
          console.error(`Cleanup could not delete channel ${channel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (deployAttempted) {
        for (const region of [...new Set(FIXTURE_FUNCTIONS.map((fn) => fn.region))]) {
          const names = FIXTURE_FUNCTIONS.filter((fn) => fn.region === region).map((fn) => fn.name);
          try {
            firebase(['functions:delete', ...names, '--region', region, '--project', projectId, '--force', '--non-interactive'], deployEnv);
          } catch (error) {
            console.error(`Cleanup could not delete functions in ${region}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          const token = await accessToken();
          const images = await deleteImages(token, projectId);
          console.log(`Deleted ${images.length} images: ${images.join(', ') || 'none'}`);
          const remaining = await remainingFunctions(token, projectId);
          console.log(remaining.length === 0 ? 'No fixture functions remain.' : `Fixture functions still deployed: ${remaining.join(', ')}`);
        } catch (error) {
          console.error(`Cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await deleteApp(app).catch(() => undefined);
    if (!completed) console.error(`Capture failed for run ${runId}; cleanup was attempted.`);
  }
}
