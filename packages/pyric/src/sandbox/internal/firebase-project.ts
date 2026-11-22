/**
 * Pure Firebase project selection shared across every Pyric plane (#1454),
 * matching firebase-tools 15.23.0 `lib/command.js` (`applyRC`,
 * `configstoreProject`) and `lib/rc.js` (`resolveAlias`):
 *
 * 1. Explicit option: Vite `project` option or CLI `--project`
 * 2. `PYRIC_PROJECT` environment variable
 * 3. `pyric.json` `project`
 * 4. `firebase use` active project from firebase-tools' configstore
 *    (`activeProjects`, walked from `projectDir` through its ancestors)
 * 5. The sole `.firebaserc` alias when there is exactly one, else
 *    `.firebaserc` `projects.default`
 *
 * Steps 1-4 resolve `.firebaserc` `projects` aliases to their project id.
 * Browser-clean: zero `node:*` or host-global dependencies.
 */

/** Where a resolved project came from. */
export type FirebaseProjectSource =
  | 'option'
  | 'PYRIC_PROJECT'
  | 'pyric-config'
  | 'firebase-use'
  | 'firebaserc';

/** The project a served or registered project runs as. Empty when no source names one. */
export interface FirebaseProjectResolution {
  projectId?: string;
  /** Where the project came from. */
  source?: FirebaseProjectSource;
  /** The `.firebaserc` alias the chosen value named. */
  alias?: string;
}

/** Minimal `.firebaserc` shape needed for project alias resolution. */
export interface FirebaseProjectRc {
  projects?: Record<string, unknown>;
}

/** Active-project lookup input supplied by Node callers from `firebase-tools.json`. */
export interface FirebaseToolsActiveLookup {
  activeProjects: Record<string, unknown>;
  /** Ancestor directory chains starting at `resolve(projectDir)` (and `realpathSync(projectDir)` when distinct). */
  ancestorChains: readonly (readonly string[])[];
}

/** Pure inputs for {@link selectFirebaseProject}. */
export interface SelectFirebaseProjectInput {
  /** Explicit project id or `.firebaserc` alias (`--project` or Vite `project`). */
  option?: string;
  /** Value of `PYRIC_PROJECT` from the environment. */
  envProject?: string;
  /** Explicit `pyric.json` `project` value, when already loaded by caller. */
  configProject?: string;
  /** Lazy reader for `<projectDir>/pyric.json` `project` when `configProject` was not passed. */
  readConfigProject?: () => string | undefined;
  /** Lazy reader for `<projectDir>/.firebaserc`. */
  readRc?: () => FirebaseProjectRc | null;
  /** Lazy reader for firebase-tools configstore `activeProjects` + ancestor chains. */
  readActiveLookup?: () => FirebaseToolsActiveLookup | null;
}

/** The sources `resolveFirebaseProject` tries, in order, for diagnostic messages. */
export const FIREBASE_PROJECT_SOURCES_TRIED =
  'the Vite plugin `project` option or --project, PYRIC_PROJECT, the pyric.json `project`, the `firebase use` active project, and .firebaserc `projects`';

/** How a developer sets the project, for diagnostic messages. */
export const FIREBASE_PROJECT_FIXES =
  'pass `project` to the Vite plugin (or --project to pyric sandbox), set PYRIC_PROJECT, or run `firebase use <alias>`';

/** Files that mark a directory as a Firebase or Pyric project root. */
export const FIREBASE_PROJECT_ROOT_MARKERS = [
  '.firebaserc',
  'firebase.json',
  'pyric.json',
] as const;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

/** Parse `activeProjects` out of `firebase-tools.json` text, or null on invalid/missing JSON. */
export function parseFirebaseToolsActiveProjects(rawJson: string): Record<string, unknown> | null {
  try {
    const store = JSON.parse(rawJson) as { activeProjects?: unknown } | null;
    if (store === null || typeof store !== 'object') {
      return null;
    }
    if (
      store.activeProjects === null ||
      typeof store.activeProjects !== 'object' ||
      Array.isArray(store.activeProjects)
    ) {
      return null;
    }
    return store.activeProjects as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse `project` out of `pyric.json` text, or undefined when absent or invalid. */
export function parsePyricConfigProject(rawJson: string): string | undefined {
  try {
    const parsed = JSON.parse(rawJson) as { project?: unknown } | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return nonEmptyString(parsed.project);
  } catch {
    return undefined;
  }
}

function findActiveProjectInChains(lookup: FirebaseToolsActiveLookup | null): string | undefined {
  if (lookup === null) {
    return undefined;
  }
  for (const chain of lookup.ancestorChains) {
    for (const dir of chain) {
      if (!Object.hasOwn(lookup.activeProjects, dir)) {
        continue;
      }
      const match = nonEmptyString(lookup.activeProjects[dir]);
      if (match !== undefined) {
        return match;
      }
    }
  }
  return undefined;
}

/** Resolve the Firebase project from pure inputs; shared by every plane. */
export function selectFirebaseProject(input: SelectFirebaseProjectInput): FirebaseProjectResolution {
  let cachedRc: FirebaseProjectRc | null | undefined;
  const aliases = (): Record<string, unknown> => {
    if (cachedRc === undefined) {
      if (input.readRc !== undefined) {
        try {
          cachedRc = input.readRc();
        } catch {
          cachedRc = null;
        }
      } else {
        cachedRc = null;
      }
    }
    const projects = cachedRc?.projects;
    if (projects !== undefined && projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
      return projects;
    }
    return {};
  };

  const chosen = (value: string, source: FirebaseProjectSource): FirebaseProjectResolution => {
    const map = aliases();
    let aliased: string | undefined;
    if (Object.hasOwn(map, value)) {
      aliased = nonEmptyString(map[value]);
    }
    if (aliased === undefined) {
      return { projectId: value, source };
    }
    return { projectId: aliased, source, alias: value };
  };

  const option = nonEmptyString(input.option);
  if (option !== undefined) {
    return chosen(option, 'option');
  }

  const fromEnv = nonEmptyString(input.envProject);
  if (fromEnv !== undefined) {
    return chosen(fromEnv, 'PYRIC_PROJECT');
  }

  let rawConfigProject = nonEmptyString(input.configProject);
  if (rawConfigProject === undefined && input.configProject === undefined && input.readConfigProject !== undefined) {
    rawConfigProject = nonEmptyString(input.readConfigProject());
  }
  if (rawConfigProject !== undefined) {
    return chosen(rawConfigProject, 'pyric-config');
  }

  let activeLookup: FirebaseToolsActiveLookup | null = null;
  if (input.readActiveLookup !== undefined) {
    activeLookup = input.readActiveLookup();
  }
  const active = findActiveProjectInChains(activeLookup);
  if (active !== undefined) {
    return chosen(active, 'firebase-use');
  }

  const validEntries: Array<[string, string]> = [];
  for (const [alias, target] of Object.entries(aliases())) {
    const project = nonEmptyString(target);
    if (project !== undefined) {
      validEntries.push([alias, project]);
    }
  }
  if (validEntries.length === 1) {
    const sole = validEntries[0];
    if (sole !== undefined) {
      return { projectId: sole[1], source: 'firebaserc', alias: sole[0] };
    }
  }
  const defaultAlias = nonEmptyString(aliases().default);
  if (defaultAlias !== undefined) {
    return { projectId: defaultAlias, source: 'firebaserc', alias: 'default' };
  }
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
  let alias = '';
  if (resolution.alias !== undefined) {
    alias = ` alias "${resolution.alias}"`;
  }
  let source = '';
  if (resolution.source !== undefined) {
    source = ` (from ${from[resolution.source]}${alias})`;
  }
  return `"${resolution.projectId}"${source}`;
}
