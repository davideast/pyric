/**
 * The Firebase project a served project runs as, resolved as firebase-tools
 * 15.23.0 resolves a command's project (`lib/command.js` `applyRC` and
 * `configstoreProject`, `lib/rc.js` `resolveAlias`):
 *
 * 1. an explicit option: the Vite plugin's `project`, or `--project`;
 * 2. `PYRIC_PROJECT`;
 * 3. the `pyric.json` `project`;
 * 4. the `firebase use` active project: firebase-tools' configstore maps a
 *    project directory to an alias or project id under `activeProjects`,
 *    matched from the project directory up through its ancestors;
 * 5. the only `.firebaserc` alias when there is exactly one, else
 *    `.firebaserc` `projects.default`.
 *
 * A value from steps 1 to 4 that names a `.firebaserc` `projects` alias
 * resolves to that alias's project id. firebase-tools reads no environment
 * variable to choose a command's project (`FIREBASE_PROJECT` only seeds
 * `firebase init`), so none besides `PYRIC_PROJECT` is read. Steps 2 and 3
 * have no firebase-tools counterpart.
 *
 * `pyric sandbox`, the Vite plugin, the `firebase.json` database rules loader
 * and the functions child all take their project from this function.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFirebaseRcSync, type FirebaseRc } from './firebase-json.js';

/** Where a resolved project came from. */
export type FirebaseProjectSource = 'option' | 'PYRIC_PROJECT' | 'pyric-config' | 'firebase-use' | 'firebaserc';

/** The project a served project runs as. Empty when no source names one. */
export interface FirebaseProjectResolution {
  projectId?: string;
  /** Where the project came from. */
  source?: FirebaseProjectSource;
  /** The `.firebaserc` alias the chosen value named. */
  alias?: string;
}

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

/** The sources {@link resolveFirebaseProject} tries, in order, for messages. */
export const FIREBASE_PROJECT_SOURCES_TRIED =
  'the Vite plugin `project` option or --project, PYRIC_PROJECT, the pyric.json `project`, the `firebase use` active project, and .firebaserc `projects`';

/** How a developer sets the project, for messages. */
export const FIREBASE_PROJECT_FIXES =
  'pass `project` to the Vite plugin (or --project to pyric sandbox), set PYRIC_PROJECT, or run `firebase use <alias>`';

/**
 * The firebase-tools configstore file, as the `configstore` package places
 * it: `$XDG_CONFIG_HOME/configstore/firebase-tools.json`, else
 * `~/.config/configstore/firebase-tools.json` on macOS, Linux and Windows.
 */
export function firebaseToolsConfigstorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), '.config');
  return join(configHome, 'configstore', 'firebase-tools.json');
}

/** Resolve the project; see the module comment for the order. */
export function resolveFirebaseProject(input: ResolveFirebaseProjectInput): FirebaseProjectResolution {
  const env = input.env ?? process.env;
  let rc: FirebaseRc | null | undefined = input.rc;
  const aliases = (): Record<string, string | undefined> => {
    if (rc === undefined) {
      try {
        rc = readFirebaseRcSync(input.projectDir);
      } catch {
        rc = null;
      }
    }
    return rc?.projects ?? {};
  };
  const chosen = (value: string, source: FirebaseProjectSource): FirebaseProjectResolution => {
    const aliased = Object.hasOwn(aliases(), value) ? nonEmpty(aliases()[value]) : undefined;
    return aliased === undefined ? { projectId: value, source } : { projectId: aliased, source, alias: value };
  };

  const option = nonEmpty(input.option);
  if (option !== undefined) return chosen(option, 'option');
  const fromEnv = nonEmpty(env.PYRIC_PROJECT);
  if (fromEnv !== undefined) return chosen(fromEnv, 'PYRIC_PROJECT');
  const fromConfig = nonEmpty(input.configProject);
  if (fromConfig !== undefined) return chosen(fromConfig, 'pyric-config');
  const active = activeProject(input.projectDir, env);
  if (active !== undefined) return chosen(active, 'firebase-use');

  const entries = Object.entries(aliases()).filter((entry): entry is [string, string] => nonEmpty(entry[1]) !== undefined);
  if (entries.length === 1) return { projectId: entries[0][1], source: 'firebaserc', alias: entries[0][0] };
  const fallback = nonEmpty(aliases().default);
  if (fallback !== undefined) return { projectId: fallback, source: 'firebaserc', alias: 'default' };
  return {};
}

/** Describe a resolved project for messages: `"id" (from PYRIC_PROJECT)`. */
export function describeFirebaseProject(resolution: FirebaseProjectResolution): string {
  const from: Record<FirebaseProjectSource, string> = {
    option: 'the project option',
    PYRIC_PROJECT: 'PYRIC_PROJECT',
    'pyric-config': 'pyric.json',
    'firebase-use': '`firebase use`',
    firebaserc: '.firebaserc',
  };
  const alias = resolution.alias === undefined ? '' : ` alias "${resolution.alias}"`;
  const source = resolution.source === undefined ? '' : ` (from ${from[resolution.source]}${alias})`;
  return `"${resolution.projectId}"${source}`;
}

/** The `firebase use` project of `projectDir` or its nearest ancestor. */
function activeProject(projectDir: string, env: NodeJS.ProcessEnv): string | undefined {
  let activeProjects: Record<string, unknown>;
  try {
    const store = JSON.parse(readFileSync(firebaseToolsConfigstorePath(env), 'utf8')) as { activeProjects?: unknown };
    if (store.activeProjects === null || typeof store.activeProjects !== 'object') return undefined;
    activeProjects = store.activeProjects as Record<string, unknown>;
  } catch {
    return undefined;
  }
  // firebase-tools keys the map by `process.cwd()`, which is the real path.
  const starts = [resolve(projectDir)];
  try {
    const real = realpathSync(projectDir);
    if (real !== starts[0]) starts.push(real);
  } catch {
    // A missing directory has no real path; the resolved path is still matched.
  }
  for (const start of starts) {
    let dir = start;
    while (true) {
      const value = activeProjects[dir];
      if (typeof value === 'string' && value.length > 0) return value;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
