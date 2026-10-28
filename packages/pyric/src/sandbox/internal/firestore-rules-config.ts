/**
 * The Firestore databases a `firebase.json` deploys to, with the rules and
 * indexes files each one gets.
 *
 * Resolved as `firebase deploy` resolves them (`lib/firestore/fsConfig.js`
 * `getFirestoreConfig` in firebase-tools 15.24.0):
 *
 * - An object deploys its `rules` and `indexes` to its `database`, or to
 *   `(default)`.
 * - In an array, an entry with `target` deploys to every database
 *   `.firebaserc` maps the target to. `target` is checked first, so an entry
 *   with both uses `target`. A target no mapping resolves is returned in
 *   `unresolved`; the caller decides what that means for it.
 * - An array entry with `database` and no `target` deploys to that database.
 * - An entry with neither throws the CLI's error.
 *
 * Two entries that deploy different rules files to one database are refused:
 * the CLI deploys both, so the configuration does not determine which
 * ruleset production keeps. This follows `database-rules-config.ts` for RTDB.
 *
 * Without a `firestore` key, or with an object that names no `rules`,
 * `firestore.rules` goes to `(default)` with `configured: false`, as pyric
 * has always read it (#1452 tracks whether it should). The array form gets no such fallback: a `firestore.rules`
 * the array does not name is not deployed, so it is not served.
 *
 * Two pyric-only rules keep what pyric enforced before it modeled named
 * databases, so no project loses enforcement it had:
 *
 * - An object whose `database` names a database other than `(default)` is
 *   still served on `(default)` by {@link defaultFirestoreDatabase}, with a
 *   warning. The result still says which database the object deploys to.
 * - An array entry `{ pyricRulesOverride: file }`, which only pyric writes
 *   (for a Vite or `pyric.config` rules override), replaces the rules the
 *   `(default)` database resolves to, however the array reaches it.
 *
 * The result shape follows ADR-0021 decision 6, so the named-database work
 * reuses it unchanged. Pure: it reads no file. Errors are plain `Error`s whose
 * message names the `firebase.json` entry; callers prefix them with their own
 * context.
 */

/** The id the SDK gives the default database. */
export const DEFAULT_FIRESTORE_DATABASE = '(default)';

/** The rules file read when `firebase.json` names none for `(default)`. */
export const DEFAULT_FIRESTORE_RULES_FILE = 'firestore.rules';

/** The key of the array entry pyric adds for a rules override; `firebase.json` never holds it. */
export const FIRESTORE_RULES_OVERRIDE_KEY = 'pyricRulesOverride';

/** The issue that tracks serving Firestore named databases. */
export const FIRESTORE_NAMED_DATABASES_ISSUE = 'https://github.com/davideast/pyric/issues/1314';

/** The files `firebase.json` deploys to one Firestore database. */
export interface FirestoreDatabaseConfig {
  /** The database id, as the SDK takes it: `(default)` or a named id. */
  database: string;
  /** The rules file, as `resolveFile` returned it. Absent when the entry deploys no rules. */
  rulesFile?: string;
  /** The indexes file, as `resolveFile` returned it. Absent when the entry deploys no indexes. */
  indexesFile?: string;
  /** The `firebase.json` entry, such as `firebase.json firestore[0]`. */
  label: string;
  /** True when `firebase.json` names the rules file, so a missing file is an error. */
  configured: boolean;
}

/** A target entry whose target no `.firebaserc` mapping resolved. */
export interface UnresolvedFirestoreTarget {
  /** The deploy target name. */
  target: string;
  /** The `firebase.json` entry, such as `firebase.json firestore[0]`. */
  label: string;
  /** The rules file, as `resolveFile` returned it. */
  rulesFile?: string;
  /** The indexes file, as `resolveFile` returned it. */
  indexesFile?: string;
}

export interface FirestoreRulesConfig {
  /** Which `firestore` form `firebase.json` uses: no key, one object, or an array. */
  form: 'absent' | 'object' | 'array';
  /** One entry per database, in `firebase.json` order. */
  databases: FirestoreDatabaseConfig[];
  /** Target entries no mapping resolved, in `firebase.json` order. */
  unresolved: UnresolvedFirestoreTarget[];
}

export interface FirestoreRulesConfigOptions {
  /**
   * The database ids `.firebaserc` maps a deploy target to for the project
   * (`targets.<project>.firestore.<target>`), as read from the file. A value
   * that is not an array of ids maps the target to no database.
   */
  targetDatabases?: (target: string) => unknown;
  /** The file as the caller reads it, such as an absolute path. Defaults to the name as written. */
  resolveFile?: (file: string) => string;
}

interface FirestoreEntry {
  database?: unknown;
  target?: unknown;
  rules?: unknown;
  indexes?: unknown;
  [FIRESTORE_RULES_OVERRIDE_KEY]?: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function asEntry(raw: unknown): FirestoreEntry {
  return raw !== null && typeof raw === 'object' ? raw : {};
}

function normalizedDatabase(id: string): string {
  return id === '' ? DEFAULT_FIRESTORE_DATABASE : id;
}

function fallbackDefault(resolveFile: (file: string) => string, indexesFile?: string): FirestoreDatabaseConfig {
  return {
    database: DEFAULT_FIRESTORE_DATABASE,
    rulesFile: resolveFile(DEFAULT_FIRESTORE_RULES_FILE),
    ...(indexesFile === undefined ? {} : { indexesFile }),
    label: 'firebase.json',
    configured: false,
  };
}

function entryFiles(entry: FirestoreEntry, resolveFile: (file: string) => string): Pick<FirestoreDatabaseConfig, 'rulesFile' | 'indexesFile'> {
  return {
    ...(nonEmptyString(entry.rules) ? { rulesFile: resolveFile(entry.rules) } : {}),
    ...(nonEmptyString(entry.indexes) ? { indexesFile: resolveFile(entry.indexes) } : {}),
  };
}

function objectConfig(entry: FirestoreEntry, resolveFile: (file: string) => string): FirestoreRulesConfig {
  const database = nonEmptyString(entry.database) ? entry.database : DEFAULT_FIRESTORE_DATABASE;
  const files = entryFiles(entry, resolveFile);
  // An object that names no rules has always fallen back to firestore.rules, whatever its database.
  const keepsTodaysFallback = files.rulesFile === undefined;
  if (keepsTodaysFallback) return { form: 'object', databases: [fallbackDefault(resolveFile, files.indexesFile)], unresolved: [] };
  const configured = files.rulesFile !== undefined;
  return { form: 'object', databases: [{ database, ...files, label: 'firebase.json firestore', configured }], unresolved: [] };
}

function addDatabase(databases: FirestoreDatabaseConfig[], next: FirestoreDatabaseConfig): void {
  const existing = databases.find((candidate) => candidate.database === next.database);
  if (existing === undefined) {
    databases.push(next);
    return;
  }
  const conflicts = existing.rulesFile !== undefined && next.rulesFile !== undefined && existing.rulesFile !== next.rulesFile;
  if (conflicts) {
    throw new Error(
      `firebase.json deploys two rules files to Firestore database "${next.database}": ${existing.rulesFile} from ${existing.label} and ${next.rulesFile} from ${next.label}. The Firebase CLI deploys both, so the configuration does not determine which one production keeps. Deploy one rules file to each database.`,
    );
  }
  if (existing.rulesFile === undefined && next.rulesFile !== undefined) {
    existing.rulesFile = next.rulesFile;
    existing.configured = true;
  }
  existing.indexesFile ??= next.indexesFile;
}

function targetIds(mapped: unknown): string[] {
  return Array.isArray(mapped) ? mapped.filter(nonEmptyString) : [];
}

/** Resolve the `firestore` value of a `firebase.json` to the files each database gets. */
export function firestoreRulesConfig(
  firestore: unknown,
  options: FirestoreRulesConfigOptions = {},
): FirestoreRulesConfig {
  const resolveFile = options.resolveFile ?? ((file: string) => file);
  const isAbsent = firestore === undefined || firestore === null || typeof firestore !== 'object';
  if (isAbsent) return { form: 'absent', databases: [fallbackDefault(resolveFile)], unresolved: [] };
  if (!Array.isArray(firestore)) return objectConfig(asEntry(firestore), resolveFile);

  const databases: FirestoreDatabaseConfig[] = [];
  const unresolved: UnresolvedFirestoreTarget[] = [];
  let override: string | undefined;
  firestore.forEach((raw: unknown, index) => {
    const label = `firebase.json firestore[${index}]`;
    const entry = asEntry(raw);
    const overrideFile = entry[FIRESTORE_RULES_OVERRIDE_KEY];
    if (nonEmptyString(overrideFile)) {
      override = resolveFile(overrideFile);
      return;
    }
    const files = entryFiles(entry, resolveFile);
    let ids: string[];
    if (nonEmptyString(entry.target)) {
      ids = targetIds(options.targetDatabases?.(entry.target));
      if (ids.length === 0) {
        unresolved.push({ target: entry.target, label, ...files });
        return;
      }
    } else if (nonEmptyString(entry.database)) {
      ids = [entry.database];
    } else {
      throw new Error(`${label}: Must supply either "target" or "databaseId" in firestore config`);
    }
    for (const id of ids) {
      addDatabase(databases, { database: normalizedDatabase(id), ...files, label, configured: files.rulesFile !== undefined });
    }
  });
  if (override !== undefined) applyOverride(databases, override);
  return { form: 'array', databases, unresolved };
}

function applyOverride(databases: FirestoreDatabaseConfig[], rulesFile: string): void {
  const label = 'the pyric rules override';
  const existing = databases.find((entry) => entry.database === DEFAULT_FIRESTORE_DATABASE);
  if (existing === undefined) {
    databases.push({ database: DEFAULT_FIRESTORE_DATABASE, rulesFile, label, configured: true });
    return;
  }
  existing.rulesFile = rulesFile;
  existing.label = label;
  existing.configured = true;
}

/** True for an object `firestore` that deploys to a named database, which pyric still serves on `(default)`. */
function isObjectForNamedDatabase(config: FirestoreRulesConfig): boolean {
  return config.form === 'object' && config.databases.length === 1 && config.databases[0]?.database !== DEFAULT_FIRESTORE_DATABASE;
}

/**
 * The entry whose rules pyric serves on `(default)`: the `(default)`
 * database's, or, for an object that names another database, that object's,
 * as pyric served it before it modeled named databases. Undefined when
 * `firebase.json` deploys nothing to `(default)`.
 */
export function defaultFirestoreDatabase(config: FirestoreRulesConfig): FirestoreDatabaseConfig | undefined {
  if (isObjectForNamedDatabase(config)) return config.databases[0];
  return config.databases.find((entry) => entry.database === DEFAULT_FIRESTORE_DATABASE);
}

/**
 * One warning per `firebase.json` entry pyric does not serve yet: each named
 * database, and each deploy target `.firebaserc` did not resolve. `displayFile`
 * turns a resolved file back into the name the warning shows.
 */
export function unservedFirestoreDatabaseWarnings(
  config: FirestoreRulesConfig,
  displayFile: (file: string) => string = (file) => file,
): string[] {
  const objectEntry = isObjectForNamedDatabase(config) ? config.databases[0] : undefined;
  if (objectEntry?.rulesFile !== undefined) {
    const file = displayFile(objectEntry.rulesFile);
    return [`firebase.json deploys ${file} to Firestore database "${objectEntry.database}". Pyric serves only (default) for now, so it enforces ${file} on (default), and getFirestore(app, "${objectEntry.database}") reads and writes (default). See ${FIRESTORE_NAMED_DATABASES_ISSUE}.`];
  }
  const named = config.databases.filter((entry) => entry.database !== DEFAULT_FIRESTORE_DATABASE);
  const namedWarnings = named.map((entry) => {
    const deploys = entry.rulesFile === undefined
      ? `firebase.json declares Firestore database "${entry.database}".`
      : `firebase.json deploys ${displayFile(entry.rulesFile)} to Firestore database "${entry.database}".`;
    return `${deploys} Pyric serves only (default) for now, so getFirestore(app, "${entry.database}") reads and writes (default) under (default)'s rules. See ${FIRESTORE_NAMED_DATABASES_ISSUE}.`;
  });
  const targetWarnings = config.unresolved.map((entry) => {
    const what = entry.rulesFile === undefined ? 'its files' : displayFile(entry.rulesFile);
    return `${entry.label} deploys ${what} to deploy target "${entry.target}", which .firebaserc does not map for this project, so pyric does not serve it. Pyric serves only (default) for now. See ${FIRESTORE_NAMED_DATABASES_ISSUE}.`;
  });
  return [...namedWarnings, ...targetWarnings];
}
