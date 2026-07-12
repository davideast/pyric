import type { ProjectAccess } from '../google/project-access.js';
import { fromServiceAccount } from '../google/service-account.js';
import { fromAdc } from '../google/adc.js';
import { fromFirebaseCli } from '../google/firebase-cli.js';

export interface ResolvedScope {
  scope: ProjectAccess;
  source: 'FIREBASE_SA_BASE64' | 'GOOGLE_APPLICATION_CREDENTIALS' | 'firebase-cli' | 'adc';
  grantedScopes: 'all';
}

export interface ResolveScopeOptions {
  projectId?: string;
  env?: NodeJS.ProcessEnv;
  adc?: (
    projectId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ProjectAccess | null>;
  firebaseCli?: (
    projectId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ProjectAccess | null>;
}

/** Resolve the non-interactive credentials used by hosted verification. */
export async function resolveScope(
  options: ResolveScopeOptions = {},
): Promise<ResolvedScope> {
  const env = options.env ?? process.env;
  const encodedServiceAccount = env.FIREBASE_SA_BASE64?.trim();
  if (encodedServiceAccount) {
    return withProject(
      await fromServiceAccount(`base64:${encodedServiceAccount}`),
      'FIREBASE_SA_BASE64',
      options.projectId ?? env.PYRIC_PROJECT,
    );
  }

  const serviceAccountPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (serviceAccountPath) {
    return withProject(
      await fromServiceAccount(serviceAccountPath),
      'GOOGLE_APPLICATION_CREDENTIALS',
      options.projectId ?? env.PYRIC_PROJECT,
    );
  }

  const projectId = options.projectId ?? env.PYRIC_PROJECT;
  if (projectId) {
    const firebaseCli = await (options.firebaseCli ?? fromFirebaseCli)(projectId, env);
    if (firebaseCli) {
      return { scope: firebaseCli, source: 'firebase-cli', grantedScopes: 'all' };
    }
    const scope = await (options.adc ?? fromAdc)(projectId, env);
    if (scope) return { scope, source: 'adc', grantedScopes: 'all' };
  }

  throw new Error(
    'pyric: hosted verification requires an existing Firebase CLI login, Application Default Credentials, or GOOGLE_APPLICATION_CREDENTIALS.',
  );
}

function withProject(
  scope: ProjectAccess,
  source: ResolvedScope['source'],
  projectId: string | undefined,
): ResolvedScope {
  const selected =
    projectId && projectId !== scope.projectId
      ? Object.freeze({ projectId, resolveToken: () => scope.resolveToken() })
      : scope;
  return { scope: selected, source, grantedScopes: 'all' };
}
