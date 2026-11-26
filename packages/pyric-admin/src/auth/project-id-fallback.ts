/**
 * Project ID fallback resolution for `pyric-admin/auth` ID token verification
 * and custom token minting.
 *
 * Resolution order:
 * 1. Explicit firebase-admin project ID (`app.options.projectId`, `cert()`,
 *    `FIREBASE_CONFIG`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`).
 * 2. In-process sandbox Auth project ID (configured by a client `FirebaseApp`
 *    or `setProjectIdSource` on the same sandbox).
 * 3. Pyric project configuration (`PYRIC_PROJECT` or nearest `pyric.json`
 *    `project`, resolving `.firebaserc` aliases when present). Bare
 *    `.firebaserc` files without `PYRIC_PROJECT` or `pyric.json` `project` are
 *    intentionally ignored so tests and unconfigured sandboxes keep
 *    `pyric-sandbox`.
 * 4. `SANDBOX_PROJECT_ID` (`pyric-sandbox`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isRemoteSandbox } from 'pyric/sandbox';
import {
  parsePyricConfigProject,
  SANDBOX_PROJECT_ID,
  selectFirebaseProject,
  type FirebaseProjectRc,
} from 'pyric/sandbox/internal';
import { sandboxAuthProjectId } from 'pyric/auth/internal';
import type { PyricAdminApp } from '../app/index.js';
import { explicitProjectId } from '../app/project-id.js';

interface PyricConfigMatch {
  readonly dir: string;
  readonly project?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function safeProcessCwd(): string | undefined {
  if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
    return undefined;
  }
  try {
    return process.cwd();
  } catch (error) {
    if (isFilesystemError(error)) {
      return undefined;
    }
    throw error;
  }
}

function readPyricJsonProject(filePath: string): string | undefined {
  try {
    return parsePyricConfigProject(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (isFilesystemError(error)) {
      return undefined;
    }
    throw error;
  }
}

function findNearestPyricConfig(startDir: string): PyricConfigMatch | null {
  let dir = resolve(startDir);
  for (;;) {
    const configPath = resolve(dir, 'pyric.json');
    if (existsSync(configPath)) {
      return { dir, project: readPyricJsonProject(configPath) };
    }
    if (existsSync(resolve(dir, '.git'))) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function findNearestFirebaseRc(startDir: string): FirebaseProjectRc | null {
  let dir = resolve(startDir);
  for (;;) {
    const rcPath = resolve(dir, '.firebaserc');
    if (existsSync(rcPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(rcPath, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as FirebaseProjectRc;
        }
        return null;
      } catch (error) {
        if (isFilesystemError(error) || error instanceof SyntaxError) {
          return null;
        }
        throw error;
      }
    }
    if (existsSync(resolve(dir, '.git'))) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function pyricConfiguredProjectId(): string | undefined {
  if (typeof process === 'undefined') {
    return undefined;
  }
  const envProject = nonEmptyString(process.env.PYRIC_PROJECT);
  const cwd = safeProcessCwd();
  let configMatch: PyricConfigMatch | null = null;
  if (cwd !== undefined) {
    configMatch = findNearestPyricConfig(cwd);
  }
  const configProject = configMatch?.project;
  if (envProject === undefined && configProject === undefined) {
    return undefined;
  }
  let rcStartDir = cwd;
  if (configMatch !== null) {
    rcStartDir = configMatch.dir;
  }
  const resolution = selectFirebaseProject({
    envProject,
    configProject,
    readRc: () => {
      if (rcStartDir === undefined) {
        return null;
      }
      return findNearestFirebaseRc(rcStartDir);
    },
  });
  return nonEmptyString(resolution.projectId);
}

/**
 * Resolve the project ID that ID tokens and custom tokens for `app` must name.
 */
export function resolveIdTokenProjectId(app: PyricAdminApp): string {
  const explicit = explicitProjectId(app);
  if (explicit !== undefined) {
    return explicit;
  }
  if (!isRemoteSandbox(app.sandbox)) {
    const fromSandbox = sandboxAuthProjectId(app.sandbox);
    if (fromSandbox !== undefined) {
      return fromSandbox;
    }
  }
  const fromPyricConfig = pyricConfiguredProjectId();
  if (fromPyricConfig !== undefined) {
    return fromPyricConfig;
  }
  return SANDBOX_PROJECT_ID;
}
