/**
 * Reads the Realtime Database rules a project's `firebase.json` deploys to
 * each instance, for `rtdbRules.fromFirebaseJson`.
 *
 * BROWSER-CLEAN: no static node imports. `pyric/rules` is reachable from
 * browser graphs, so `node:fs` and `node:path` are acquired lazily through
 * `process.getBuiltinModule`; in a browser the loader throws saying it needs
 * a file system.
 */

import { databaseRulesConfig } from '../../sandbox/internal/database-rules-config.js';

export interface RtdbFirebaseJsonOptions {
  /**
   * The project id, which names the default instance
   * `<projectId>-default-rtdb` and selects the `.firebaserc` deploy-target
   * mappings. Defaults to `projects.default` in the `.firebaserc` beside
   * `firebase.json`.
   */
  projectId?: string;
}

/** One rules file's text and the instances it deploys to. */
interface LoadedRulesFile {
  /** The file as `firebase.json` names it. */
  file: string;
  /** The absolute path read. */
  path: string;
  text: string;
  /** The instances it deploys to, in `firebase.json` order. */
  instances: string[];
}

export interface LoadedFirebaseJsonRules {
  defaultInstance: string;
  /** The project id the rules were resolved for, when one was set. */
  projectId?: string;
  files: LoadedRulesFile[];
}

interface NodeFs {
  readFileSync(path: string, encoding: 'utf-8'): string;
}
interface NodePath {
  resolve(...paths: string[]): string;
  dirname(path: string): string;
}

const NAME = 'rtdbRules.fromFirebaseJson';

function nodeModules(): { fs: NodeFs; path: NodePath } {
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  const fs = typeof get === 'function' ? (get.call(process, 'node:fs') as NodeFs | undefined) : undefined;
  const path = typeof get === 'function' ? (get.call(process, 'node:path') as NodePath | undefined) : undefined;
  if (fs === undefined || path === undefined) {
    throw new Error(`${NAME} reads files, which needs Node.js 20.16 or later, Bun or Deno. Without a file system, pass each instance's rules text to rtdbRules.`);
  }
  return { fs, path };
}

/** The file's text, or null when it does not exist. */
function readText(fs: NodeFs, path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${NAME}: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface FirebaseRc {
  projects?: { default?: unknown };
  targets?: Record<string, { database?: Record<string, unknown> } | undefined>;
}

/**
 * Read `firebase.json` at `firebaseJsonPath`, the `.firebaserc` beside it,
 * and every rules file it deploys to a database instance.
 *
 * @throws {Error} when a file cannot be read or is not JSON, when
 *   `firebase.json` deploys no Realtime Database rules, when a deploy target
 *   maps to no instance for the project, or for a `database` config the
 *   Firebase CLI refuses.
 */
export function loadFirebaseJsonRules(
  firebaseJsonPath: string,
  options: RtdbFirebaseJsonOptions = {},
): LoadedFirebaseJsonRules {
  const { fs, path } = nodeModules();
  const jsonPath = path.resolve(firebaseJsonPath);
  const projectDir = path.dirname(jsonPath);
  const configText = readText(fs, jsonPath);
  if (configText === null) throw new Error(`${NAME}: there is no firebase.json at ${jsonPath}.`);
  const config = parseJson(configText, jsonPath) as { database?: unknown } | null;

  let rc: FirebaseRc | null | undefined;
  const readRc = (): FirebaseRc | null => {
    if (rc !== undefined) return rc;
    const rcPath = path.resolve(projectDir, '.firebaserc');
    const text = readText(fs, rcPath);
    rc = text === null ? null : parseJson(text, rcPath) as FirebaseRc | null;
    return rc;
  };
  // .firebaserc is read only when it is needed: for the project id when no
  // option names one, and for the instances a deploy target maps to.
  // An empty project id is unset, as it is in .firebaserc, not the instance '-default-rtdb'.
  let projectId = options.projectId === '' ? undefined : options.projectId;
  if (projectId === undefined) {
    const rcProject = readRc()?.projects?.default;
    if (typeof rcProject === 'string' && rcProject !== '') projectId = rcProject;
  }

  let resolved;
  try {
    resolved = databaseRulesConfig(config?.database, {
      ...(projectId === undefined ? {} : { projectId }),
      targetInstances: (target) => (projectId === undefined ? undefined : readRc()?.targets?.[projectId]?.database?.[target]),
      resolveFile: (file) => path.resolve(projectDir, file),
    });
  } catch (error) {
    throw new Error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [unresolved] = resolved.unresolved;
  if (unresolved !== undefined) {
    const why = projectId === undefined
      ? 'no project id is set: pass { projectId } or set projects.default in .firebaserc'
      : `.firebaserc maps it to no instance for project "${projectId}" (firebase target:apply database ${unresolved.target} <instance>)`;
    throw new Error(`${NAME}: ${unresolved.label} deploys to target "${unresolved.target}", and ${why}.`);
  }

  const files = new Map<string, LoadedRulesFile>();
  for (const target of resolved.targets) {
    const existing = files.get(target.file);
    if (existing !== undefined) {
      existing.instances.push(target.instance);
      continue;
    }
    const text = readText(fs, target.file);
    if (text === null && !target.configured) continue;
    if (text === null) {
      throw new Error(`${NAME}: ${target.file} does not exist, and ${target.label} deploys it to database instance "${target.instance}".`);
    }
    files.set(target.file, { file: target.configuredFile, path: target.file, text, instances: [target.instance] });
  }
  if (files.size === 0) {
    throw new Error(`${NAME}: ${jsonPath} deploys no Realtime Database rules.`);
  }
  return { defaultInstance: resolved.defaultInstance, ...(projectId === undefined ? {} : { projectId }), files: [...files.values()] };
}
