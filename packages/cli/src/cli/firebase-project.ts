/**
 * The Firebase project a served or CLI-invoked project runs as, delegating
 * precedence and `.firebaserc` alias resolution to the shared pure
 * `selectFirebaseProject` in `pyric/sandbox/internal` (#1454) while supplying
 * Node filesystem/configstore readers.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  FIREBASE_PROJECT_FIXES,
  FIREBASE_PROJECT_ROOT_MARKERS,
  FIREBASE_PROJECT_SOURCES_TRIED,
  describeFirebaseProject,
  parseFirebaseToolsActiveProjects,
  parsePyricConfigProject,
  selectFirebaseProject,
  type FirebaseProjectResolution,
  type FirebaseProjectSource,
  type FirebaseToolsActiveLookup,
} from 'pyric/sandbox/internal';
import { readFirebaseRcSync, type FirebaseRc } from './firebase-json.js';

export {
  FIREBASE_PROJECT_FIXES,
  FIREBASE_PROJECT_SOURCES_TRIED,
  describeFirebaseProject,
  type FirebaseProjectResolution,
  type FirebaseProjectSource,
};

export interface ResolveFirebaseProjectInput {
  /** The directory that holds `firebase.json` and `.firebaserc`. */
  projectDir: string;
  /** The explicit project: the Vite plugin's `project`, or `--project`. */
  option?: string;
  /** The `pyric.json` `project`. */
  configProject?: string;
  /** Environment for `PYRIC_PROJECT`, `HOME` and `XDG_CONFIG_HOME`. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The parsed `.firebaserc`. Default: read from `projectDir`. */
  rc?: FirebaseRc | null;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

/**
 * The firebase-tools configstore file, as the `configstore` package places
 * it: `$XDG_CONFIG_HOME/configstore/firebase-tools.json`, else
 * `~/.config/configstore/firebase-tools.json` on macOS, Linux and Windows.
 */
export function firebaseToolsConfigstorePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) {
    return join(xdg, 'configstore', 'firebase-tools.json');
  }
  const home = nonEmpty(env.HOME) ?? homedir();
  return join(home, '.config', 'configstore', 'firebase-tools.json');
}

export function isFirebaseProjectRoot(dir: string): boolean {
  return FIREBASE_PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/**
 * The Firebase or Pyric project root for a process or server started in `startDir`:
 * the nearest folder from `startDir` up that holds `.firebaserc`, `firebase.json`,
 * or `pyric.json` without crossing an enclosing `.git` boundary, or `null` when
 * none does.
 */
export function findFirebaseProjectDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (isFirebaseProjectRoot(dir)) return dir;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ancestorChain(start: string): string[] {
  const chain: string[] = [];
  let dir = start;
  for (;;) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function readActiveLookup(projectDir: string, env: NodeJS.ProcessEnv): FirebaseToolsActiveLookup | null {
  const storePath = firebaseToolsConfigstorePath(env);
  if (!existsSync(storePath)) {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(storePath, 'utf8');
  } catch (error) {
    if (isFilesystemError(error)) return null;
    throw error;
  }
  const activeProjects = parseFirebaseToolsActiveProjects(raw);
  if (activeProjects === null) {
    return null;
  }
  const resolvedStart = resolve(projectDir);
  const chains: string[][] = [ancestorChain(resolvedStart)];
  if (existsSync(projectDir)) {
    try {
      const realStart = realpathSync(projectDir);
      if (realStart !== resolvedStart) {
        chains.push(ancestorChain(realStart));
      }
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
    }
  }
  return { activeProjects, ancestorChains: chains };
}

function readPyricJsonProject(projectDir: string): string | undefined {
  const pyricPath = join(projectDir, 'pyric.json');
  if (!existsSync(pyricPath)) {
    return undefined;
  }
  try {
    return parsePyricConfigProject(readFileSync(pyricPath, 'utf8'));
  } catch (error) {
    if (isFilesystemError(error)) return undefined;
    throw error;
  }
}

/** Resolve the project; see `selectFirebaseProject` in `pyric/sandbox/internal` for the order. */
export function resolveFirebaseProject(input: ResolveFirebaseProjectInput): FirebaseProjectResolution {
  const env = input.env ?? process.env;
  return selectFirebaseProject({
    option: input.option,
    envProject: env.PYRIC_PROJECT,
    configProject: input.configProject,
    readConfigProject: () => readPyricJsonProject(input.projectDir),
    readRc: () => {
      if (input.rc !== undefined) {
        return input.rc;
      }
      return readFirebaseRcSync(input.projectDir);
    },
    readActiveLookup: () => readActiveLookup(input.projectDir, env),
  });
}
