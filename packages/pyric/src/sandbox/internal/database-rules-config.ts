/**
 * The Realtime Database rules a `firebase.json` deploys, per instance.
 *
 * Resolved as `firebase deploy` resolves them (`lib/database/rulesConfig.js`
 * `getRulesConfig` in firebase-tools 15.23.0):
 *
 * - A single object's `rules` deploys to the default instance. Without
 *   `rules` it deploys nothing.
 * - An array entry's `rules` deploys to every instance `.firebaserc` maps its
 *   `target` to, else to its `instance`. An entry with neither throws the
 *   CLI's error. An entry without `rules` deploys nothing.
 * - A target no mapping resolves is returned in `unresolved`; the caller
 *   decides what that means for it.
 * - Without a `database` key, `database.rules.json` deploys to the default
 *   instance when it exists (`configured: false`).
 *
 * Instance names are normalized with {@link databaseInstanceNamed}. Two
 * entries that deploy different files to one instance are refused: the CLI
 * deploys both concurrently, so the configuration does not determine which
 * ruleset production keeps.
 *
 * Pure: it reads no file. Errors are plain `Error`s whose message names the
 * `firebase.json` entry; callers prefix them with their own context.
 */

import {
  databaseInstanceKey,
  databaseInstanceNamed,
  defaultDatabaseInstanceName,
} from './instances.js';

/** The rules file read when `firebase.json` has no `database` key. */
export const DEFAULT_DATABASE_RULES_FILE = 'database.rules.json';

/** One rules file deployed to one database instance. */
export interface DatabaseRulesFileTarget {
  /** The instance name, as the SDK names it. */
  instance: string;
  /** The rules file, as `resolveFile` returned it. */
  file: string;
  /** The rules file as `firebase.json` names it. */
  configuredFile: string;
  /** The `firebase.json` entry, such as `firebase.json database[0]`. */
  label: string;
  /** True when `firebase.json` names the file, so a missing file is an error. */
  configured: boolean;
}

/** A target entry whose target no `.firebaserc` mapping resolved. */
export interface UnresolvedDatabaseRulesTarget {
  /** The deploy target name. */
  target: string;
  /** The `firebase.json` entry, such as `firebase.json database[0]`. */
  label: string;
  /** The rules file, as `resolveFile` returned it. */
  file: string;
}

export interface DatabaseRulesConfig {
  /** The instance `getDatabase()` selects without a URL. */
  defaultInstance: string;
  /** One entry per instance, in `firebase.json` order. */
  targets: DatabaseRulesFileTarget[];
  /** Target entries no mapping resolved, in `firebase.json` order. */
  unresolved: UnresolvedDatabaseRulesTarget[];
}

export interface DatabaseRulesConfigOptions {
  /** The project id, which names the default instance `<projectId>-default-rtdb`. */
  projectId?: string;
  /**
   * The instance names `.firebaserc` maps a deploy target to for the project,
   * as read from the file. A value that is not an array of names maps the
   * target to no instance.
   */
  targetInstances?: (target: string) => unknown;
  /** The rules file as the caller reads it, such as an absolute path. Defaults to the name as written. */
  resolveFile?: (file: string) => string;
}

interface DatabaseRulesEntry {
  instance?: unknown;
  target?: unknown;
  rules?: unknown;
}

// The rules formats `firebase deploy` accepts (lib/deploy/database/prepare.js).
function checkRulesFormat(file: string, label: string): void {
  const dot = file.lastIndexOf('.');
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const extension = dot > slash + 1 ? file.slice(dot) : '';
  if (extension === '.json') return;
  const reason = extension === '.bolt'
    ? 'As of firebase-tools@15.0.0, .bolt rules are no longer supported.'
    : `Unexpected rules format ${extension}`;
  throw new Error(`${label}: ${reason}`);
}

/** Resolve the `database` value of a `firebase.json` to the rules each instance gets. */
export function databaseRulesConfig(
  database: unknown,
  options: DatabaseRulesConfigOptions = {},
): DatabaseRulesConfig {
  const resolveFile = options.resolveFile ?? ((file: string) => file);
  const defaultInstance = options.projectId === undefined
    ? databaseInstanceKey(undefined)
    : defaultDatabaseInstanceName(options.projectId);

  if (database === undefined || database === null) {
    const configuredFile = DEFAULT_DATABASE_RULES_FILE;
    return {
      defaultInstance,
      targets: [{ instance: defaultInstance, file: resolveFile(configuredFile), configuredFile, label: 'firebase.json', configured: false }],
      unresolved: [],
    };
  }
  if (!Array.isArray(database)) {
    const rules = typeof database === 'object' ? (database as DatabaseRulesEntry).rules : undefined;
    if (typeof rules !== 'string' || rules === '') return { defaultInstance, targets: [], unresolved: [] };
    const label = 'firebase.json database.rules';
    checkRulesFormat(rules, label);
    return {
      defaultInstance,
      targets: [{ instance: defaultInstance, file: resolveFile(rules), configuredFile: rules, label, configured: true }],
      unresolved: [],
    };
  }

  const targets: DatabaseRulesFileTarget[] = [];
  const unresolved: UnresolvedDatabaseRulesTarget[] = [];
  database.forEach((raw: unknown, index) => {
    const label = `firebase.json database[${index}]`;
    const entry: DatabaseRulesEntry = raw !== null && typeof raw === 'object' ? raw : {};
    let names: readonly string[];
    if (typeof entry.target === 'string' && entry.target !== '') {
      const mapped = options.targetInstances?.(entry.target);
      names = Array.isArray(mapped) ? mapped.filter((name): name is string => typeof name === 'string' && name !== '') : [];
    } else if (typeof entry.instance === 'string' && entry.instance !== '') {
      names = [entry.instance];
    } else {
      throw new Error(`${label}: Must supply either "target" or "instance" in database config`);
    }
    if (typeof entry.rules !== 'string' || entry.rules === '') return;
    checkRulesFormat(entry.rules, label);
    const file = resolveFile(entry.rules);
    if (names.length === 0 && typeof entry.target === 'string') {
      unresolved.push({ target: entry.target, label, file });
      return;
    }
    for (const name of names) {
      let instance: string;
      try {
        instance = databaseInstanceNamed(name).name;
      } catch (error) {
        const reason = error instanceof Error ? error.message.trim() : String(error);
        throw new Error(`${label}: instance "${name}" is not a database instance name: ${reason}`);
      }
      const existing = targets.find((target) => target.instance === instance);
      if (existing === undefined) {
        targets.push({ instance, file, configuredFile: entry.rules, label, configured: true });
        continue;
      }
      if (existing.file === file) continue;
      throw new Error(
        `firebase.json deploys two rules files to database instance "${instance}": ${existing.file} from ${existing.label} and ${file} from ${label}. The Firebase CLI deploys both at once, so the configuration does not determine which one production keeps. Deploy one rules file to each instance.`,
      );
    }
  });
  return { defaultInstance, targets, unresolved };
}
