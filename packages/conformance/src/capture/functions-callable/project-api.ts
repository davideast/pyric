/**
 * Firebase CLI and Google Cloud REST helpers for deploying, inspecting, and
 * tearing down the `functions-callable` oracle fixture.
 */
import { spawn } from 'node:child_process';
import {
  deployOutcome,
  inactiveFunctions,
  type CaptureState,
  type FirebaseTools,
} from '../functions-http/deploy.ts';
import type { WebAppConfig } from './browser-runner.ts';

export interface FixtureFunction {
  name: string;
  region: string;
  platform: 'gcfv1' | 'gcfv2';
}

export const CALLABLE_REGION = 'us-central1';
export const CALLABLE_CODEBASE = 'pyric-functions-callable-oracle';
export const CALLABLE_CHANNEL_EXPIRES = '1d';

export const FIXTURE_FUNCTIONS: readonly FixtureFunction[] = [
  { name: 'pyricCallableEcho', region: CALLABLE_REGION, platform: 'gcfv2' },
  { name: 'pyricCallableEnforced', region: CALLABLE_REGION, platform: 'gcfv2' },
  { name: 'pyricCallableConsume', region: CALLABLE_REGION, platform: 'gcfv2' },
  { name: 'pyricCallableStream', region: CALLABLE_REGION, platform: 'gcfv2' },
  { name: 'pyricCallableV1', region: CALLABLE_REGION, platform: 'gcfv1' },
];

export const REQUIRED_PERMISSIONS: Record<string, readonly string[]> = {
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
  'Firebase Hosting Admin': ['firebasehosting.sites.get', 'firebasehosting.sites.update'],
  'Firebase Authentication Admin': [
    'firebaseauth.users.create',
    'firebaseauth.users.get',
    'firebaseauth.users.delete',
  ],
  'Firebase App Check Admin': [
    'firebaseappcheck.debugTokens.get',
    'firebaseappcheck.debugTokens.update',
  ],
  'Logs Viewer': ['logging.logEntries.list'],
  'Artifact Registry cleanup (images)': [
    'artifactregistry.packages.list',
    'artifactregistry.packages.delete',
  ],
  'Firebase CLI and Web App reads': [
    'firebase.projects.get',
    'firebase.clients.list',
    'firebase.clients.get',
    'resourcemanager.projects.get',
    'serviceusage.services.get',
  ],
};

interface FirebaseRun {
  status: number | null;
  stdout: string;
  output: string;
}

export function runFirebaseCli(
  firebaseTools: FirebaseTools,
  repoRoot: string,
  args: string[],
  env: Record<string, string>,
): Promise<FirebaseRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [firebaseTools.bin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env, NO_COLOR: '1' },
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

async function execFirebase(
  firebaseTools: FirebaseTools,
  repoRoot: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const result = await runFirebaseCli(firebaseTools, repoRoot, args, env);
  if (result.status !== 0) throw new Error(`firebase ${args[0]} exited ${result.status}`);
  return result.stdout;
}

export async function googleApi(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let method = 'GET';
  if (init.method) method = init.method;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${new URL(url).pathname} failed: ${response.status} ${text.slice(0, 300)}`,
    );
  }
  if (text.length === 0) return {};
  return JSON.parse(text);
}

export async function resolveWebConfig(token: string, projectId: string): Promise<WebAppConfig> {
  const rawConfig =
    (process.env.PYRIC_ORACLE_FIREBASE_CONFIG ?? '').trim() ||
    (process.env.PYRIC_AI_FIREBASE_CONFIG ?? '').trim();
  if (rawConfig !== '') {
    const parsed = JSON.parse(rawConfig) as WebAppConfig;
    if (parsed.projectId !== projectId) {
      throw new Error('Firebase web config projectId does not match oracle project');
    }
    return parsed;
  }
  const listed = (await googleApi(
    token,
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps?pageSize=20`,
  )) as { apps?: Array<{ name?: string; appId?: string }> };
  const firstApp = listed.apps?.[0];
  if (!firstApp?.name) {
    throw new Error(
      `No Firebase Web App found in project ${projectId}; set PYRIC_ORACLE_FIREBASE_CONFIG or create a Web App.`,
    );
  }
  const config = (await googleApi(
    token,
    `https://firebase.googleapis.com/v1beta1/${firstApp.name}/config`,
  )) as WebAppConfig;
  if (!config.apiKey || !config.appId) {
    throw new Error(`Firebase Web App config for ${projectId} is missing apiKey or appId`);
  }
  return config;
}

async function inactiveFixtureFunctions(token: string, projectId: string): Promise<string[]> {
  const states = new Map<string, string>();
  const v2Fns = FIXTURE_FUNCTIONS.filter((entry) => entry.platform === 'gcfv2');
  for (const fn of v2Fns) {
    try {
      const body = (await googleApi(
        token,
        `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${fn.region}/functions/${fn.name}`,
      )) as { state?: string };
      if (body.state) states.set(fn.name, body.state);
    } catch (err: unknown) {
      let detail = String(err);
      if (err instanceof Error) detail = err.message;
      console.error(`Could not read ${fn.name}: ${detail}`);
    }
  }
  return inactiveFunctions(
    v2Fns.map((fn) => fn.name),
    states,
  );
}

export async function deployCallableFixture(options: {
  firebaseTools: FirebaseTools;
  repoRoot: string;
  configPath: string;
  projectId: string;
  env: Record<string, string>;
  getToken: () => Promise<string>;
}): Promise<void> {
  const { firebaseTools, repoRoot, configPath, projectId, env, getToken } = options;
  const result = await runFirebaseCli(
    firebaseTools,
    repoRoot,
    [
      'deploy',
      '--config',
      configPath,
      '--project',
      projectId,
      '--only',
      `functions:${CALLABLE_CODEBASE}`,
      '--non-interactive',
    ],
    env,
  );
  const outcome = deployOutcome(result.status, result.output);
  if (outcome === 'failed') throw new Error(`firebase deploy exited ${result.status}`);
  if (outcome === 'deployed-without-cleanup-policy') {
    console.log('Functions deployed. No cleanup policy was set; this run deletes its own images.');
    const inactive = await inactiveFixtureFunctions(await getToken(), projectId);
    if (inactive.length > 0) {
      throw new Error(`firebase deploy left fixture functions not ACTIVE: ${inactive.join(', ')}`);
    }
  }
}

export async function checkCallablePermissions(
  token: string,
  projectId: string,
): Promise<string[]> {
  const permissions = [...new Set(Object.values(REQUIRED_PERMISSIONS).flat())];
  const result = (await googleApi(
    token,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
    { method: 'POST', body: JSON.stringify({ permissions }) },
  )) as { permissions?: string[] };
  const granted = new Set(result.permissions ?? []);
  const missing: string[] = [];
  for (const [role, needed] of Object.entries(REQUIRED_PERMISSIONS)) {
    const absent = needed.filter((permission) => !granted.has(permission));
    let statusLabel = 'ok     ';
    let suffix = '';
    if (absent.length > 0) {
      statusLabel = 'missing';
      suffix = `: ${absent.join(', ')}`;
    }
    console.log(`${statusLabel} ${role}${suffix}`);
    missing.push(...absent);
  }
  return missing;
}

export async function runServiceUri(
  token: string,
  projectId: string,
  fn: FixtureFunction,
): Promise<string> {
  const body = (await googleApi(
    token,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${fn.region}/functions/${fn.name}`,
  )) as { serviceConfig?: { uri?: string } };
  const uri = body.serviceConfig?.uri;
  if (!uri) throw new Error(`${fn.name} has no Cloud Run URI`);
  console.log(`${fn.name}: run URL https://${fn.name.toLowerCase()}-<hash>-<rc>.a.run.app`);
  return uri.replace(/\/$/, '');
}

export async function deployPreviewChannel(options: {
  firebaseTools: FirebaseTools;
  repoRoot: string;
  configPath: string;
  channel: string;
  projectId: string;
  env: Record<string, string>;
}): Promise<string> {
  const { firebaseTools, repoRoot, configPath, channel, projectId, env } = options;
  const output = await execFirebase(
    firebaseTools,
    repoRoot,
    [
      'hosting:channel:deploy',
      channel,
      '--expires',
      CALLABLE_CHANNEL_EXPIRES,
      '--config',
      configPath,
      '--project',
      projectId,
      '--json',
      '--non-interactive',
    ],
    env,
  );
  const parsed = JSON.parse(output) as { result?: Record<string, { url?: string }> };
  const url = Object.values(parsed.result ?? {})[0]?.url;
  if (!url) throw new Error('hosting:channel:deploy returned no channel URL');
  return url.replace(/\/$/, '');
}

async function deleteImages(token: string, projectId: string): Promise<string[]> {
  const deleted: string[] = [];
  const regions = [...new Set(FIXTURE_FUNCTIONS.map((fn) => fn.region))];
  const suffixes = FIXTURE_FUNCTIONS.map((fn) => fn.name.toLowerCase());
  for (const region of regions) {
    const base = `https://artifactregistry.googleapis.com/v1/projects/${projectId}/locations/${region}/repositories/gcf-artifacts/packages`;
    let listed: { packages?: Array<{ name: string }> };
    try {
      listed = (await googleApi(token, `${base}?pageSize=1000`)) as typeof listed;
    } catch (err: unknown) {
      let detail = String(err);
      if (err instanceof Error) detail = err.message;
      console.error(`Could not list images in ${region}: ${detail}`);
      continue;
    }
    for (const { name } of listed.packages ?? []) {
      const packageId = decodeURIComponent(name.split('/').pop() ?? '');
      const normalized = packageId.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!suffixes.some((suffix) => normalized.endsWith(suffix))) continue;
      try {
        await googleApi(token, `https://artifactregistry.googleapis.com/v1/${name}`, {
          method: 'DELETE',
        });
        deleted.push(`${region}/${packageId}`);
      } catch (err: unknown) {
        let detail = String(err);
        if (err instanceof Error) detail = err.message;
        console.error(`Could not delete image ${packageId}: ${detail}`);
      }
    }
  }
  return deleted;
}

async function remainingFunctions(token: string, projectId: string): Promise<string[]> {
  const body = (await googleApi(
    token,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/-/functions?pageSize=1000`,
  )) as { functions?: Array<{ name: string }> };
  const names = new Set(FIXTURE_FUNCTIONS.map((fn) => fn.name));
  return (body.functions ?? [])
    .map((fn) => fn.name.split('/').pop() ?? '')
    .filter((name) => names.has(name));
}

export async function cleanUpCallableDeploy(options: {
  firebaseTools: FirebaseTools;
  repoRoot: string;
  state: CaptureState;
  env: Record<string, string>;
  deleteChannel: boolean;
  getToken: () => Promise<string>;
}): Promise<boolean> {
  const { firebaseTools, repoRoot, state, env, deleteChannel, getToken } = options;
  if (deleteChannel) {
    try {
      await execFirebase(
        firebaseTools,
        repoRoot,
        ['hosting:channel:delete', state.channel, '--project', state.projectId, '--force', '--non-interactive'],
        env,
      );
      console.log(`Deleted hosting channel ${state.channel}.`);
    } catch (err: unknown) {
      let detail = String(err);
      if (err instanceof Error) detail = err.message;
      console.error(`Cleanup could not delete channel ${state.channel}: ${detail}`);
    }
  }
  for (const region of [...new Set(FIXTURE_FUNCTIONS.map((fn) => fn.region))]) {
    const names = FIXTURE_FUNCTIONS.filter((fn) => fn.region === region).map((fn) => fn.name);
    try {
      await execFirebase(
        firebaseTools,
        repoRoot,
        ['functions:delete', ...names, '--region', region, '--project', state.projectId, '--force', '--non-interactive'],
        env,
      );
    } catch (err: unknown) {
      let detail = String(err);
      if (err instanceof Error) detail = err.message;
      console.error(`Cleanup could not delete functions in ${region}: ${detail}`);
    }
  }
  try {
    const token = await getToken();
    const images = await deleteImages(token, state.projectId);
    let imageList = 'none';
    if (images.length > 0) imageList = images.join(', ');
    console.log(`Deleted ${images.length} images: ${imageList}`);
    const remaining = await remainingFunctions(token, state.projectId);
    if (remaining.length === 0) {
      console.log('No fixture functions remain.');
    } else {
      console.log(`Fixture functions still deployed: ${remaining.join(', ')}`);
    }
    return remaining.length === 0;
  } catch (err: unknown) {
    let detail = String(err);
    if (err instanceof Error) detail = err.message;
    console.error(`Cleanup verification failed: ${detail}`);
    return false;
  }
}
