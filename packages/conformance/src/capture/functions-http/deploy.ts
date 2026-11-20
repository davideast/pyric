/**
 * The parts of the functions-http capture that decide something without
 * touching production: which firebase-tools runs, what a deploy's exit means,
 * and the state file an interrupted run leaves for the next start to clean up.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The firebase-tools release the functions-http rows cite. */
export const FIREBASE_TOOLS_VERSION = '15.23.0';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
/** The workspace package that installs firebase-tools. */
const FIREBASE_TOOLS_OWNER = join(REPO_ROOT, 'packages', 'playground', 'package.json');

interface FirebaseToolsManifest {
  version: string;
  bin: { firebase: string };
}

export interface FirebaseTools {
  version: string;
  /** Absolute path of the `firebase` bin script, run with node. */
  bin: string;
}

function readWorkspaceManifest(): FirebaseToolsManifest & { dir: string } {
  let manifestPath: string;
  try {
    manifestPath = createRequire(FIREBASE_TOOLS_OWNER).resolve('firebase-tools/package.json');
  } catch {
    throw new Error('firebase-tools is not installed in the workspace (packages/playground); run bun install at the repository root.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FirebaseToolsManifest;
  return { ...manifest, dir: dirname(manifestPath) };
}

/**
 * The workspace's firebase-tools, refused unless it is the release the rows
 * cite, so a capture never runs whatever `firebase` is on PATH.
 */
export function resolveFirebaseTools(
  readManifest: () => FirebaseToolsManifest & { dir?: string } = readWorkspaceManifest,
): FirebaseTools {
  const manifest = readManifest();
  const isPinnedVersion = manifest.version === FIREBASE_TOOLS_VERSION;
  if (!isPinnedVersion) {
    throw new Error(
      `firebase-tools ${manifest.version} is installed; the capture needs ${FIREBASE_TOOLS_VERSION}, the release the functions-http rows cite.`,
    );
  }
  return { version: manifest.version, bin: join(manifest.dir ?? '', manifest.bin.firebase) };
}

export type DeployOutcome = 'deployed' | 'deployed-without-cleanup-policy' | 'failed';

/**
 * firebase-tools 15.23.0 (`lib/deploy/functions/prompts.js:179-189`, called
 * from `release/index.js:149`): after every function deployed, a region whose
 * gcf-artifacts repository has no cleanup policy makes a non-interactive
 * deploy without `--force` throw this and exit 1.
 */
const CLEANUP_POLICY_REFUSAL = /^Error: Functions successfully deployed but could not set up cleanup policy in locations? /m;
/** Any other `Error:` line firebase-tools' `logError` printed. */
const ERROR_LINE = /^Error: /gm;
/**
 * What `reporter.printErrors` prints, with `logger.info` and no `Error:`
 * prefix, when a function failed. In 15.23.0 the cleanup policy refusal is
 * thrown after it and before "There was an error deploying functions", so a
 * partial failure can end in the refusal alone.
 */
const FUNCTION_FAILURE_LINES = [
  'Functions deploy had errors with the following functions:',
  'Unable to set the invoker for the IAM policy on the following functions:',
];
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/**
 * What a `firebase deploy --non-interactive` run did. The cleanup policy
 * refusal counts as deployed: the capture sets no policy on the project and
 * deletes its own images instead. It counts only when it is the one error and
 * no function failure was reported before it.
 */
export function deployOutcome(status: number | null, output: string): DeployOutcome {
  if (status === 0) return 'deployed';
  if (status === null) return 'failed';
  const plain = output.replace(ANSI_ESCAPE, '');
  const reportedFunctionFailure = FUNCTION_FAILURE_LINES.some((line) => plain.includes(line));
  if (reportedFunctionFailure) return 'failed';
  const errorLines = plain.match(ERROR_LINE) ?? [];
  const isOnlyCleanupPolicyRefusal = errorLines.length === 1 && CLEANUP_POLICY_REFUSAL.test(plain);
  return isOnlyCleanupPolicyRefusal ? 'deployed-without-cleanup-policy' : 'failed';
}

/**
 * The fixture functions that are not ACTIVE, by the state the Cloud Functions
 * v2 API reports for each (absent when it has none), as `name (STATE)`.
 */
export function inactiveFunctions(names: readonly string[], states: ReadonlyMap<string, string>): string[] {
  return names.flatMap((name) => {
    const state = states.get(name);
    if (state === 'ACTIVE') return [];
    return [`${name} (${state ?? 'not deployed'})`];
  });
}

/** The run a later start must clean up if this one never reaches its own cleanup. */
export interface CaptureState {
  runId: string;
  channel: string;
  projectId: string;
  startedAt: string;
}

function isCaptureState(value: unknown): value is CaptureState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['runId', 'channel', 'projectId', 'startedAt'].every((key) => typeof record[key] === 'string');
}

export function readCaptureState(path: string): CaptureState | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isCaptureState(parsed)) throw new Error(`${path} is not a capture state; delete it after checking the project by hand.`);
  return parsed;
}

export function writeCaptureState(path: string, state: CaptureState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearCaptureState(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export type CaptureCredentialConfig =
  | {
      kind: 'service-account-key';
      credPath: string;
      projectId: string;
      clientEmail: string;
    }
  | {
      kind: 'application-default';
      credPath?: string;
      projectId: string;
      clientEmail: string;
    };

export type CaptureCredentialResolution =
  | { ok: true; config: CaptureCredentialConfig }
  | { ok: false; missing: string };

const IMPERSONATION_SA_PATTERN = /\/serviceAccounts\/([^/:]+)/;

function trimEnv(value: string | undefined): string {
  if (value === undefined) return '';
  return value.trim();
}

function decodeEmailSegment(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolves capture credentials from either a service-account key file
 * (`PYRIC_ORACLE_SA_PATH`, or `GOOGLE_APPLICATION_CREDENTIALS` with
 * `"type": "service_account"`) or Workload Identity Federation / ADC
 * (`GOOGLE_APPLICATION_CREDENTIALS` with `"type": "external_account"`, or ADC
 * paired with `PYRIC_ORACLE_PROJECT_ID` and `CAPTURE_SA_EMAIL`).
 */
export function resolveCaptureCredentials(
  env: Readonly<Record<string, string | undefined>>,
  cwd = process.cwd(),
): CaptureCredentialResolution {
  const saPathEnv = trimEnv(env.PYRIC_ORACLE_SA_PATH);
  const adcPathEnv = trimEnv(env.GOOGLE_APPLICATION_CREDENTIALS);
  let explicitPath = '';
  if (saPathEnv !== '') {
    explicitPath = resolve(cwd, saPathEnv);
  } else if (adcPathEnv !== '') {
    explicitPath = resolve(cwd, adcPathEnv);
  }

  let parsedType = '';
  let parsedProjectId = '';
  let parsedClientEmail = '';
  let parsedImpersonationEmail = '';

  if (explicitPath !== '') {
    if (!existsSync(explicitPath)) {
      return { ok: false, missing: `credential file does not exist: ${explicitPath}` };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(explicitPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, missing: `credential file is not valid JSON: ${explicitPath}` };
    }
    if (typeof parsed.type === 'string') parsedType = parsed.type;
    if (typeof parsed.project_id === 'string') parsedProjectId = parsed.project_id.trim();
    if (typeof parsed.client_email === 'string') parsedClientEmail = parsed.client_email.trim();
    if (typeof parsed.service_account_impersonation_url === 'string') {
      const match = IMPERSONATION_SA_PATTERN.exec(parsed.service_account_impersonation_url);
      parsedImpersonationEmail = decodeEmailSegment(match?.[1]);
    }
  }

  let projectId = parsedProjectId;
  if (projectId === '') {
    projectId = trimEnv(env.PYRIC_ORACLE_PROJECT_ID);
  }
  if (projectId === '') {
    projectId = trimEnv(env.PARITY_PROJECT_ID);
  }

  let clientEmail = parsedClientEmail;
  if (clientEmail === '') {
    clientEmail = trimEnv(env.CAPTURE_SA_EMAIL);
  }
  if (clientEmail === '') {
    clientEmail = parsedImpersonationEmail;
  }

  const isServiceAccountKey =
    parsedType === 'service_account' || (saPathEnv !== '' && parsedType === '');

  if (isServiceAccountKey) {
    if (explicitPath === '') {
      return { ok: false, missing: 'PYRIC_ORACLE_SA_PATH or GOOGLE_APPLICATION_CREDENTIALS' };
    }
    if (projectId === '' || clientEmail === '') {
      return { ok: false, missing: 'project_id and client_email in service-account key file' };
    }
    return {
      ok: true,
      config: {
        kind: 'service-account-key',
        credPath: explicitPath,
        projectId,
        clientEmail,
      },
    };
  }

  if (explicitPath === '' && trimEnv(env.PYRIC_ORACLE_PROJECT_ID) === '') {
    return {
      ok: false,
      missing: 'PYRIC_ORACLE_SA_PATH or GOOGLE_APPLICATION_CREDENTIALS + PYRIC_ORACLE_PROJECT_ID',
    };
  }
  if (projectId === '') {
    return { ok: false, missing: 'PYRIC_ORACLE_PROJECT_ID' };
  }
  if (clientEmail === '') {
    return { ok: false, missing: 'CAPTURE_SA_EMAIL (service account email for runtime.cjs)' };
  }
  const config: CaptureCredentialConfig = {
    kind: 'application-default',
    projectId,
    clientEmail,
  };
  if (explicitPath !== '') {
    config.credPath = explicitPath;
  }
  return { ok: true, config };
}
