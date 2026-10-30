/**
 * The credential the messaging rigs (messaging-send, messaging-web, and the
 * provisioning check) send to FCM with.
 *
 * Two sources, chosen by one condition:
 *   - `PYRIC_MESSAGING_SA_BASE64` holds a base64 service-account key: the key
 *     signs locally, as it always has, and its `project_id` names the project.
 *   - `PYRIC_MESSAGING_SA_BASE64` is unset: Application Default Credentials,
 *     through the oracle credential module, so the account check and the log
 *     line are the oracle rigs' own. The project comes from
 *     `PYRIC_MESSAGING_PROJECT_ID`, or `PYRIC_ORACLE_PROJECT_ID` when the
 *     messaging project is the oracle project.
 *
 * Both sources return an `OracleServiceAccount`, so `oracleAppOptions` and
 * `oracleAccessToken` serve the messaging rigs unchanged.
 */
import { applicationDefault, cert } from 'firebase-admin/app';
import {
  loadOracleServiceAccount,
  oracleAccessToken,
  type OracleCredentialDeps,
  type OracleCredentialVariables,
  type OracleEnv,
  type OracleKey,
  type OracleServiceAccount,
} from './oracle-credential.ts';

export const MESSAGING_KEY_VARIABLE = 'PYRIC_MESSAGING_SA_BASE64';
export const MESSAGING_PROJECT_VARIABLE = 'PYRIC_MESSAGING_PROJECT_ID';
const ORACLE_PROJECT_VARIABLE = 'PYRIC_ORACLE_PROJECT_ID';

/**
 * The scope an FCM HTTP v1 send needs. A key mints a token for exactly this
 * scope. Under ADC, firebase-admin's credential asks for its whole scope set,
 * which includes both this scope and cloud-platform.
 */
export const FIREBASE_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * The variables the ADC path reads. The messaging account must belong to the
 * messaging project, as the oracle account must belong to the oracle project.
 */
export const MESSAGING_VARIABLES: OracleCredentialVariables = {
  keyPath: MESSAGING_KEY_VARIABLE,
  project: MESSAGING_PROJECT_VARIABLE,
  accountInProject: true,
};

export type MessagingCredentialSource = 'base64-key' | 'application-default';

export type MessagingCredentialDeps = Omit<OracleCredentialDeps, 'readFile'>;

const defaultDeps: MessagingCredentialDeps = {
  cert: (key) => cert(key as Parameters<typeof cert>[0]),
  applicationDefault: () => applicationDefault(),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

/** A base64 key wins when its variable is set. Otherwise the rig uses ADC. */
export function selectMessagingCredentialSource(env: OracleEnv): MessagingCredentialSource {
  const keyIsSet = Boolean(env[MESSAGING_KEY_VARIABLE]);
  return keyIsSet ? 'base64-key' : 'application-default';
}

/** The messaging project for ADC: its own variable, or the oracle project. */
export function messagingProjectId(env: OracleEnv): string | undefined {
  return env[MESSAGING_PROJECT_VARIABLE] || env[ORACLE_PROJECT_VARIABLE] || undefined;
}

/**
 * Load the messaging credential the environment selects, and log the account
 * it acts as. Refuses a key from a project other than a named
 * `PYRIC_MESSAGING_PROJECT_ID`, and under ADC refuses an account outside the
 * messaging project.
 */
export async function loadMessagingServiceAccount(
  env: OracleEnv = process.env,
  deps: MessagingCredentialDeps = defaultDeps,
): Promise<OracleServiceAccount> {
  if (selectMessagingCredentialSource(env) === 'base64-key') return base64KeyAccount(env, deps);
  return applicationDefaultAccount(env, deps);
}

function base64KeyAccount(env: OracleEnv, deps: MessagingCredentialDeps): OracleServiceAccount {
  const key = decodeKey(env[MESSAGING_KEY_VARIABLE]!);
  assertKeyInNamedProject(key, env[MESSAGING_PROJECT_VARIABLE]);
  deps.log(`[messaging] credential: key from ${MESSAGING_KEY_VARIABLE} for ${key.client_email}, project ${key.project_id}`);
  return { kind: 'key-file', key, project_id: key.project_id, credential: deps.cert(key) };
}

function decodeKey(base64: string): OracleKey {
  const key = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Partial<OracleKey>;
  const complete = Boolean(key.project_id && key.client_email && key.private_key);
  if (complete) return key as OracleKey;
  throw new Error(
    `${MESSAGING_KEY_VARIABLE} does not decode to a service-account key with project_id, client_email, and private_key.`,
  );
}

function assertKeyInNamedProject(key: OracleKey, namedProject: string | undefined): void {
  const projectNamed = Boolean(namedProject);
  if (!projectNamed || key.project_id === namedProject) return;
  throw new Error(
    `${MESSAGING_KEY_VARIABLE} is a key for project ${key.project_id}, but ${MESSAGING_PROJECT_VARIABLE} is ${namedProject}. ` +
      `Unset one of them, or make them name the same project.`,
  );
}

async function applicationDefaultAccount(
  env: OracleEnv,
  deps: MessagingCredentialDeps,
): Promise<OracleServiceAccount> {
  const projectId = messagingProjectId(env);
  if (!projectId) {
    throw new Error(
      `${MESSAGING_KEY_VARIABLE} is unset, so the messaging rig uses Application Default Credentials, which carry no project. ` +
        `Set ${MESSAGING_PROJECT_VARIABLE}, or ${ORACLE_PROJECT_VARIABLE} when messaging runs on the oracle project.`,
    );
  }
  const oracleDeps: OracleCredentialDeps = { ...deps, readFile: unreadable };
  return loadOracleServiceAccount({ ...env, [MESSAGING_PROJECT_VARIABLE]: projectId }, MESSAGING_VARIABLES, oracleDeps);
}

/** The ADC path never reads a key file: its key variable is unset whenever it runs. */
function unreadable(path: string): string {
  throw new Error(`The messaging ADC path does not read key files (asked for ${path}).`);
}

/** An access token for a raw FCM HTTP v1 `messages:send` call. */
export function messagingAccessToken(sa: OracleServiceAccount): Promise<string> {
  return oracleAccessToken(sa, FIREBASE_MESSAGING_SCOPE);
}

/** The FCM HTTP v1 send endpoint for the credential's project. */
export function messagingSendEndpoint(sa: OracleServiceAccount): string {
  return `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
}
