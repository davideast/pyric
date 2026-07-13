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
 */
import { fromAdc } from '../credentials/node/from-adc.js';
import { fromServiceAccount } from '../credentials/node/from-service-account.js';
import type { ProjectScope } from '../credentials/core/types.js';

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
  const saBase64 = env.FIREBASE_SA_BASE64;
  if (saBase64 && saBase64.trim() !== '') {
    return withProject(await fromServiceAccount(`base64:${saBase64}`), 'FIREBASE_SA_BASE64', options, env);
  }
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && gac.trim() !== '') {
    return withProject(await fromServiceAccount(gac), 'GOOGLE_APPLICATION_CREDENTIALS', options, env);
  }

  // ADC user credentials are not bound to a project.
  const projectId = options.projectId ?? env.PYRIC_PROJECT;
  if (projectId) {
    const adcScope = await (options.adc ?? fromAdc)(projectId, env);
    if (adcScope) return { scope: adcScope, source: 'adc' };
  }

  throw new Error(
    'pyric: Rules Test API verification requires FIREBASE_SA_BASE64, ' +
      'GOOGLE_APPLICATION_CREDENTIALS, or Application Default Credentials from ' +
      '`gcloud auth application-default login`.',
  );
}

function withProject(
  baseScope: ProjectScope,
  source: ResolvedScope['source'],
  options: ResolveScopeOptions,
  env: NodeJS.ProcessEnv,
): ResolvedScope {
  const overrideProjectId = options.projectId ?? env.PYRIC_PROJECT;
  const scope =
    overrideProjectId && overrideProjectId !== baseScope.projectId
      ? Object.freeze({ projectId: overrideProjectId, resolveToken: baseScope.resolveToken })
      : baseScope;
  return { scope, source };
}
