/**
 * The parts of the functions-http capture that decide something without
 * touching production: which firebase-tools runs, what a deploy's exit means,
 * and the state file an interrupted run leaves for the next start to clean up.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const manifestPath = createRequire(FIREBASE_TOOLS_OWNER).resolve('firebase-tools/package.json');
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
 * What a `firebase deploy --non-interactive` run did. The cleanup policy
 * refusal counts as deployed: the capture sets no policy on the project and
 * deletes its own images instead. It counts only when it is the one error.
 */
export function deployOutcome(status: number | null, output: string): DeployOutcome {
  if (status === 0) return 'deployed';
  if (status === null) return 'failed';
  const errorLines = output.match(ERROR_LINE) ?? [];
  const isOnlyCleanupPolicyRefusal = errorLines.length === 1 && CLEANUP_POLICY_REFUSAL.test(output);
  return isOnlyCleanupPolicyRefusal ? 'deployed-without-cleanup-policy' : 'failed';
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
