/**
 * The staging target `pyric verify --engine staging` replays against, from
 * the project's `pyric.json`:
 *
 *   { "verify": { "staging": { "project": "my-staging", "rtdb": "https://my-verify.firebaseio.com" } } }
 *
 * `rtdb` is a database URL or an instance name (`my-verify` resolves to
 * `https://my-verify.firebaseio.com`; an instance outside us-central1 needs
 * its full URL). The user brings the instance; pyric provisions nothing.
 *
 * An instance the app's own `firebase.json` deploys rules to, or the app
 * project's default instance, is refused: those hold the app's data.
 */
import { readFileSync } from 'node:fs';

import { resolveDatabaseInstance } from 'pyric/sandbox/internal';

import { firebaseToolsConfigstorePath } from '../../cli/firebase-project.js';
import type { FirebaseJson } from '../../cli/firebase-json.js';
import { resolveScope } from '../../credentials/node/scope.js';

export interface StagingTarget {
  projectId: string;
  databaseUrl: string;
  /** The instance name the URL names. */
  instance: string;
}

export class StagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingConfigError';
  }
}

const CONFIG_EXAMPLE = '{ "verify": { "staging": { "project": "<staging project id>", "rtdb": "https://<dedicated instance>.firebaseio.com" } } }';

/** The staging target in a parsed `pyric.json`, or a config error naming what is missing. */
export function stagingTargetFrom(config: unknown): StagingTarget {
  const staging = (config as { verify?: { staging?: unknown } } | null)?.verify?.staging;
  if (staging === undefined) {
    throw new StagingConfigError(`no staging target. Add one to pyric.json: ${CONFIG_EXAMPLE}`);
  }
  const { project, rtdb } = (staging ?? {}) as { project?: unknown; rtdb?: unknown };
  if (typeof project !== 'string' || project.trim() === '') {
    throw new StagingConfigError(`pyric.json verify.staging.project must name the staging project: ${CONFIG_EXAMPLE}`);
  }
  if (typeof rtdb !== 'string' || rtdb.trim() === '') {
    throw new StagingConfigError(`pyric.json verify.staging.rtdb must name the dedicated instance: ${CONFIG_EXAMPLE}`);
  }
  const trimmed = rtdb.trim();
  const databaseUrl = /^[a-z0-9-]+$/i.test(trimmed) ? `https://${trimmed}.firebaseio.com` : trimmed.replace(/\/+$/, '');
  let instance: string | undefined;
  try {
    instance = resolveDatabaseInstance(databaseUrl)?.name;
  } catch {
    instance = undefined;
  }
  if (instance === undefined) {
    throw new StagingConfigError(`pyric.json verify.staging.rtdb "${rtdb}" is not a Realtime Database URL or instance name.`);
  }
  return { projectId: project.trim(), databaseUrl, instance };
}

/**
 * Refuse a staging instance the app uses: one `firebase.json` deploys rules
 * to (by instance or by a `.firebaserc` target), or the default instance of
 * the app's project.
 */
export function assertNotAppInstance(
  target: StagingTarget,
  app: { firebaseJson: FirebaseJson | null; appProjectId?: string; targetInstances?: string[] },
): void {
  const declared = new Set<string>(app.targetInstances ?? []);
  const database = app.firebaseJson?.database as unknown;
  const entries = Array.isArray(database) ? database : database ? [database] : [];
  for (const entry of entries) {
    const instance = (entry as { instance?: unknown }).instance;
    if (typeof instance === 'string') declared.add(instance);
  }
  if (app.appProjectId) declared.add(`${app.appProjectId}-default-rtdb`);
  if (declared.has(target.instance)) {
    throw new StagingConfigError(
      `refusing staging instance ${target.instance}: the app uses it (firebase.json deploys rules to it, or it is the default instance of project ${app.appProjectId}). The staging engine replaces an instance's rules and data, so it needs one dedicated to it.`,
    );
  }
}

/**
 * An OAuth token for the staging project: a service account or Application
 * Default Credentials (`resolveScope`), else the Firebase CLI's login
 * (`firebase login`) while its access token is fresh.
 */
export async function stagingToken(
  projectId: string,
  deps: { resolve?: typeof resolveScope; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<{ token: () => Promise<string>; source: string }> {
  try {
    const { scope, source } = await (deps.resolve ?? resolveScope)({ projectId, ...(deps.env ? { env: deps.env } : {}) });
    return { token: () => scope.resolveToken(), source };
  } catch (resolveError) {
    const cli = firebaseCliToken(deps.env ?? process.env, (deps.now ?? Date.now)());
    if (cli !== undefined) return { token: async () => cli, source: 'firebase login' };
    throw new StagingConfigError(
      `no credentials for staging project ${projectId}. ${resolveError instanceof Error ? resolveError.message : String(resolveError)} ` +
        'Or sign in with `firebase login` (a CLI token is used while it is fresh; run any firebase command to refresh it).',
    );
  }
}

/** The Firebase CLI's access token, when its configstore holds one valid for at least five more minutes. */
function firebaseCliToken(env: NodeJS.ProcessEnv, now: number): string | undefined {
  try {
    const store = JSON.parse(readFileSync(firebaseToolsConfigstorePath(env), 'utf8')) as {
      tokens?: { access_token?: unknown; expires_at?: unknown };
    };
    const token = store.tokens?.access_token;
    const expiresAt = store.tokens?.expires_at;
    if (typeof token !== 'string' || token === '') return undefined;
    if (typeof expiresAt === 'number' && expiresAt - now < 5 * 60_000) return undefined;
    return token;
  } catch {
    return undefined;
  }
}
