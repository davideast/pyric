/**
 * `resolveScope` — build a `ProjectScope` for hosted Rules Test API verification.
 *
 * Credential sources, in precedence order:
 *   1. `FIREBASE_SA_BASE64` — base64 service-account JSON (CI). Grants all scopes.
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` — path to a service-account JSON file.
 *   3. ADC (`gcloud auth application-default login` / workload identity) — the
 *      ambient keyless fallback.
 *
 * Service accounts win so CI is deterministic. ADC user credentials are not
 * bound to a project, so they need `--project` / `.firebaserc`.
 *
 * The variable names are declared here and nowhere else. Every message that
 * tells a caller which sources were read builds its sentence from them, so a
 * rename cannot leave a document naming a variable the resolver stopped
 * reading.
 */
import { fromAdc } from './from-adc.js';
import { fromServiceAccount } from './from-service-account.js';
import type { ProjectScope } from '../core/types.js';

/** Base64 service-account JSON. First source read, and the one CI sets. */
export const SERVICE_ACCOUNT_BASE64_ENV_KEY = 'FIREBASE_SA_BASE64';

/** Path to a service-account JSON file. Second source read. */
export const SERVICE_ACCOUNT_FILE_ENV_KEY = 'GOOGLE_APPLICATION_CREDENTIALS';

/** The project id ADC user credentials have to be told, because they carry none. */
export const PROJECT_ID_ENV_KEY = 'PYRIC_PROJECT';

/** The credential sources the hosted engine reads, in the order it reads them. */
export const HOSTED_CREDENTIAL_SOURCES = `${SERVICE_ACCOUNT_BASE64_ENV_KEY}, ${SERVICE_ACCOUNT_FILE_ENV_KEY}, or Application Default Credentials from \`gcloud auth application-default login\` with a project id in ${PROJECT_ID_ENV_KEY}`;

export interface ResolvedScope {
  scope: ProjectScope;
  source: 'FIREBASE_SA_BASE64' | 'GOOGLE_APPLICATION_CREDENTIALS' | 'adc';
}

export interface ResolveScopeOptions {
  projectId?: string | undefined;
  env?: NodeJS.ProcessEnv;
  adc?: (projectId: string, env: NodeJS.ProcessEnv) => Promise<ProjectScope | null>;
}

export async function resolveScope(options: ResolveScopeOptions = {}): Promise<ResolvedScope> {
  const env = options.env ?? process.env;

  // 1 + 2. Service-account env (CI) — highest precedence; grants all scopes.
  const saBase64 = env[SERVICE_ACCOUNT_BASE64_ENV_KEY];
  if (saBase64 && saBase64.trim() !== '') {
    return withProject(
      await fromServiceAccount(`base64:${saBase64}`),
      SERVICE_ACCOUNT_BASE64_ENV_KEY,
      options,
      env,
    );
  }
  const gac = env[SERVICE_ACCOUNT_FILE_ENV_KEY];
  if (gac && gac.trim() !== '') {
    return withProject(
      await fromServiceAccount(gac),
      SERVICE_ACCOUNT_FILE_ENV_KEY,
      options,
      env,
    );
  }

  // ADC user credentials are not bound to a project.
  const projectId = options.projectId ?? env[PROJECT_ID_ENV_KEY];
  if (projectId) {
    const adcScope = await (options.adc ?? fromAdc)(projectId, env);
    if (adcScope) return { scope: adcScope, source: 'adc' };
  }

  throw new Error(
    `pyric: Rules Test API verification requires ${SERVICE_ACCOUNT_BASE64_ENV_KEY}, ` +
      `${SERVICE_ACCOUNT_FILE_ENV_KEY}, or Application Default Credentials from ` +
      '`gcloud auth application-default login`.',
  );
}

function withProject(
  baseScope: ProjectScope,
  source: ResolvedScope['source'],
  options: ResolveScopeOptions,
  env: NodeJS.ProcessEnv,
): ResolvedScope {
  const overrideProjectId = options.projectId ?? env[PROJECT_ID_ENV_KEY];
  const scope =
    overrideProjectId && overrideProjectId !== baseScope.projectId
      ? Object.freeze({ projectId: overrideProjectId, resolveToken: baseScope.resolveToken })
      : baseScope;
  return { scope, source };
}
