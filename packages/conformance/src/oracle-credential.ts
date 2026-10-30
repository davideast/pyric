/**
 * The credential the oracle captures authenticate with.
 *
 * Two sources, chosen by one condition:
 *   - `PYRIC_ORACLE_SA_PATH` names a service-account key file: the key signs
 *     locally, as it always has.
 *   - `PYRIC_ORACLE_SA_PATH` is unset: Application Default Credentials. The
 *     oracle runs keyless this way, after
 *     `gcloud auth application-default login --impersonate-service-account=<sa>`.
 *     An impersonated credential has no private key, so signing goes through
 *     the IAM Credentials `signBlob` endpoint.
 *
 * ADC carries no project, so the project comes from `PYRIC_ORACLE_PROJECT_ID`.
 * A key file carries its own `project_id`.
 *
 * The account keeps the key file's `project_id` field name so the many capture
 * helpers that read `sa.project_id` take either source unchanged.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applicationDefault, cert, type Credential } from 'firebase-admin/app';
import { mintAccessToken, type ServiceAccountKey } from './oracle-access-token.ts';

const ORACLE_KEY_PATH_VARIABLE = 'PYRIC_ORACLE_SA_PATH';
const ORACLE_PROJECT_VARIABLE = 'PYRIC_ORACLE_PROJECT_ID';

const IAM_CREDENTIALS_API = 'https://iamcredentials.googleapis.com/v1';

export type OracleEnv = Readonly<Record<string, string | undefined>>;

/** The fields of a service-account key file the captures read. */
export interface OracleKey extends ServiceAccountKey {
  project_id: string;
}

export type OracleCredentialSource =
  | { kind: 'key-file'; path: string }
  | { kind: 'application-default' };

interface OracleAccountBase {
  /** The oracle project: the key's `project_id`, or the project variable under ADC. */
  project_id: string;
  /** The firebase-admin credential for `initializeApp({ credential })`. */
  credential: Credential;
}

export type OracleServiceAccount =
  | (OracleAccountBase & { kind: 'key-file'; key: OracleKey })
  | (OracleAccountBase & { kind: 'application-default' });

/** The variables one oracle credential is read from. The secondary project uses its own pair. */
export interface OracleCredentialVariables {
  keyPath: string;
  project: string;
}

export const ORACLE_VARIABLES: OracleCredentialVariables = {
  keyPath: ORACLE_KEY_PATH_VARIABLE,
  project: ORACLE_PROJECT_VARIABLE,
};

/** The secondary Firestore project the Storage cross-service probes isolate against. */
export const SECONDARY_ORACLE_VARIABLES: OracleCredentialVariables = {
  keyPath: 'PYRIC_SECONDARY_ORACLE_SA_PATH',
  project: 'PYRIC_SECONDARY_ORACLE_PROJECT_ID',
};

/** The seams a test replaces: reading the key file and building firebase-admin credentials. */
export interface OracleCredentialDeps {
  readFile(path: string): string;
  cert(key: OracleKey): Credential;
  applicationDefault(): Credential;
}

const defaultDeps: OracleCredentialDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  cert: (key) => cert(key as Parameters<typeof cert>[0]),
  applicationDefault: () => applicationDefault(),
};

/** A key file wins when its variable is set. Otherwise the capture uses ADC. */
export function selectOracleCredentialSource(
  env: OracleEnv,
  variables: OracleCredentialVariables = ORACLE_VARIABLES,
  cwd = process.cwd(),
): OracleCredentialSource {
  const keyPath = env[variables.keyPath];
  const keyFileNamed = Boolean(keyPath);
  if (keyFileNamed) return { kind: 'key-file', path: resolve(cwd, keyPath!) };
  return { kind: 'application-default' };
}

/**
 * True when the environment names an oracle credential: a key file, or a
 * project for ADC. Captures that print an inert plan without one gate on this.
 */
export function oracleCredentialConfigured(
  env: OracleEnv,
  variables: OracleCredentialVariables = ORACLE_VARIABLES,
): boolean {
  return Boolean(env[variables.keyPath] || env[variables.project]);
}

/** The ADC project, from its variable. ADC has no project of its own to fall back on. */
export function applicationDefaultProject(
  env: OracleEnv,
  variables: OracleCredentialVariables = ORACLE_VARIABLES,
): string {
  const projectId = env[variables.project];
  if (projectId) return projectId;
  throw new Error(
    `${variables.keyPath} is unset, so the capture uses Application Default Credentials, ` +
      `which carry no project. Set ${variables.project} to the oracle project id.`,
  );
}

/** Load the oracle credential the environment selects. */
export function loadOracleServiceAccount(
  env: OracleEnv = process.env,
  variables: OracleCredentialVariables = ORACLE_VARIABLES,
  deps: OracleCredentialDeps = defaultDeps,
): OracleServiceAccount {
  const source = selectOracleCredentialSource(env, variables);
  if (source.kind === 'key-file') return keyFileAccount(source.path, deps);
  return applicationDefaultAccount(applicationDefaultProject(env, variables), deps);
}

function keyFileAccount(path: string, deps: OracleCredentialDeps): OracleServiceAccount {
  const key = JSON.parse(deps.readFile(path)) as OracleKey;
  return { kind: 'key-file', key, project_id: key.project_id, credential: deps.cert(key) };
}

function applicationDefaultAccount(projectId: string, deps: OracleCredentialDeps): OracleServiceAccount {
  return { kind: 'application-default', project_id: projectId, credential: deps.applicationDefault() };
}

/** The firebase-admin app options that reach the oracle project with this credential. */
export function oracleAppOptions(sa: OracleServiceAccount): { credential: Credential; projectId: string } {
  return { credential: sa.credential, projectId: sa.project_id };
}

/** A one-line description of the credential for a capture log. Names no secret. */
export function describeOracleCredential(sa: OracleServiceAccount): string {
  if (sa.kind === 'key-file') return `key file for ${sa.key.client_email}`;
  return 'Application Default Credentials';
}

/**
 * An OAuth access token. A key file mints one for exactly `scope`. ADC returns
 * firebase-admin's token, whose scopes (cloud-platform, firebase.database,
 * userinfo.email, and the rest of firebase-admin's set) cover every scope the
 * captures ask for.
 */
export async function oracleAccessToken(sa: OracleServiceAccount, scope: string): Promise<string> {
  if (sa.kind === 'key-file') return mintAccessToken(sa.key, scope);
  return (await sa.credential.getAccessToken()).access_token;
}

/** firebase-admin's ADC credential can name the account it acts as; the public type omits it. */
interface AccountNamingCredential {
  getServiceAccountEmail(): Promise<string>;
}

function namesItsAccount(credential: Credential): credential is Credential & AccountNamingCredential {
  return typeof (credential as Partial<AccountNamingCredential>).getServiceAccountEmail === 'function';
}

/** The service account the credential acts as: the key's, or the impersonated one under ADC. */
export async function oracleServiceAccountEmail(sa: OracleServiceAccount): Promise<string> {
  if (sa.kind === 'key-file') return sa.key.client_email;
  const email = namesItsAccount(sa.credential) ? await sa.credential.getServiceAccountEmail() : '';
  if (email) return email;
  throw new Error(
    'Application Default Credentials name no service account. Log in with ' +
      '`gcloud auth application-default login --impersonate-service-account=<oracle service account>`.',
  );
}

/**
 * RS256-sign `bytes` as the oracle service account. A key signs locally; ADC
 * calls IAM Credentials `signBlob`, because an impersonated credential has no
 * private key.
 */
export async function oracleSignBlob(
  sa: OracleServiceAccount,
  bytes: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  if (sa.kind === 'key-file') return signLocally(sa.key, bytes);
  return signWithIamCredentials(sa, bytes, fetchImpl);
}

function signLocally(key: OracleKey, bytes: Uint8Array): Buffer {
  const signer = createSign('RSA-SHA256');
  signer.update(bytes);
  return signer.sign(key.private_key);
}

async function signWithIamCredentials(
  sa: OracleServiceAccount,
  bytes: Uint8Array,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const email = await oracleServiceAccountEmail(sa);
  const token = (await sa.credential.getAccessToken()).access_token;
  const response = await fetchImpl(
    `${IAM_CREDENTIALS_API}/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: Buffer.from(bytes).toString('base64') }),
    },
  );
  if (!response.ok) throw new Error(`IAM Credentials signBlob failed: ${response.status} ${await response.text()}`);
  return Buffer.from(((await response.json()) as { signedBlob: string }).signedBlob, 'base64');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An RS256 JWT carrying `payload`, signed as the oracle service account. */
export async function signOracleJwt(
  sa: OracleServiceAccount,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const unsigned = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson(payload)}`;
  const signature = await oracleSignBlob(sa, Buffer.from(unsigned), fetchImpl);
  return `${unsigned}.${signature.toString('base64url')}`;
}
