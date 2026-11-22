/**
 * The Firestore databases a `firebase.json` deploys to, with the rules and
 * indexes files each one gets (ADR-0021 Decision 6).
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
 * `firestore.rules` goes to `(default)` with `configured: false` (#1452). When
 * an object names a non-`(default)` `database` and no `rules`, that database is
 * also declared with no `rulesFile` so server-only Admin projects work with
 * `{ "database": "reports" }`. The array form gets no `firestore.rules`
 * fallback.
 *
 * An array entry `{ pyricRulesOverride: file }`, which only pyric writes (for a
 * Vite or `pyric.config` rules override), replaces the rules `(default)`
 * resolves to, however the configuration reaches it.
 */

/** The id the SDK gives the default database. */
export const DEFAULT_FIRESTORE_DATABASE = '(default)';

/** The rules file read when `firebase.json` names none for `(default)`. */
export const DEFAULT_FIRESTORE_RULES_FILE = 'firestore.rules';

/** The key of the array entry pyric adds for a rules override; `firebase.json` never holds it. */
export const FIRESTORE_RULES_OVERRIDE_KEY = 'pyricRulesOverride';

/** The issue that tracks serving Firestore named databases (kept for back-compat). */
export const FIRESTORE_NAMED_DATABASES_ISSUE = 'https://github.com/davideast/pyric/issues/1314';

/** Production quota on declared Firestore databases per project, `(default)` included. */
export const MAX_CONFIGURED_FIRESTORE_DATABASES = 100;

const DATABASE_ID_RULE_RE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` is `(default)` or passes Firebase's named-database naming rules (ADR-0021 Decision 1). */
export function isValidFirestoreDatabaseConfigId(id: string): boolean {
  if (id === DEFAULT_FIRESTORE_DATABASE) {
    return true;
  }
  if (!DATABASE_ID_RULE_RE.test(id)) {
    return false;
  }
  if (UUID_SHAPE_RE.test(id)) {
    return false;
  }
  return true;
}

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
  if (raw !== null && typeof raw === 'object') {
    return raw as FirestoreEntry;
  }
  return {};
}

function normalizedDatabase(id: string): string {
  if (id === '') {
    return DEFAULT_FIRESTORE_DATABASE;
  }
  return id;
}

function fallbackDefault(
  resolveFile: (file: string) => string,
  indexesFile?: string,
): FirestoreDatabaseConfig {
  const entry: FirestoreDatabaseConfig = {
    database: DEFAULT_FIRESTORE_DATABASE,
    rulesFile: resolveFile(DEFAULT_FIRESTORE_RULES_FILE),
    label: 'firebase.json',
    configured: false,
  };
  if (indexesFile !== undefined) {
    entry.indexesFile = indexesFile;
  }
  return entry;
}

function entryFiles(
  entry: FirestoreEntry,
  resolveFile: (file: string) => string,
): Pick<FirestoreDatabaseConfig, 'rulesFile' | 'indexesFile'> {
  const files: Pick<FirestoreDatabaseConfig, 'rulesFile' | 'indexesFile'> = {};
  if (nonEmptyString(entry.rules)) {
    files.rulesFile = resolveFile(entry.rules);
  }
  if (nonEmptyString(entry.indexes)) {
    files.indexesFile = resolveFile(entry.indexes);
  }
  return files;
}

function objectConfig(
  entry: FirestoreEntry,
  resolveFile: (file: string) => string,
): FirestoreRulesConfig {
  let database = DEFAULT_FIRESTORE_DATABASE;
  if (nonEmptyString(entry.database)) {
    database = entry.database;
  }
  const files = entryFiles(entry, resolveFile);
  if (files.rulesFile === undefined) {
    if (database === DEFAULT_FIRESTORE_DATABASE) {
      return {
        form: 'object',
        databases: [fallbackDefault(resolveFile, files.indexesFile)],
        unresolved: [],
      };
    }
    const namedDeclaration: FirestoreDatabaseConfig = {
      database,
      label: 'firebase.json firestore',
      configured: false,
    };
    if (files.indexesFile !== undefined) {
      namedDeclaration.indexesFile = files.indexesFile;
    }
    return {
      form: 'object',
      databases: [fallbackDefault(resolveFile), namedDeclaration],
      unresolved: [],
    };
  }
  const single: FirestoreDatabaseConfig = {
    database,
    rulesFile: files.rulesFile,
    label: 'firebase.json firestore',
    configured: true,
  };
  if (files.indexesFile !== undefined) {
    single.indexesFile = files.indexesFile;
  }
  return { form: 'object', databases: [single], unresolved: [] };
}

function addDatabase(databases: FirestoreDatabaseConfig[], next: FirestoreDatabaseConfig): void {
  const existing = databases.find((candidate) => candidate.database === next.database);
  if (existing === undefined) {
    databases.push(next);
    return;
  }
  const conflicts =
    existing.rulesFile !== undefined &&
    next.rulesFile !== undefined &&
    existing.rulesFile !== next.rulesFile;
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
  if (!Array.isArray(mapped)) {
    return [];
  }
  return mapped.filter(nonEmptyString);
}

function assertConfiguredDatabaseCap(databases: readonly FirestoreDatabaseConfig[]): void {
  let validNamedCount = 0;
  for (const entry of databases) {
    if (entry.database === DEFAULT_FIRESTORE_DATABASE) {
      continue;
    }
    if (isValidFirestoreDatabaseConfigId(entry.database)) {
      validNamedCount += 1;
    }
  }
  // `(default)` is always one of the project's databases alongside named databases.
  const totalDatabases = 1 + validNamedCount;
  if (totalDatabases > MAX_CONFIGURED_FIRESTORE_DATABASES) {
    throw new Error(
      `firebase.json declares ${String(totalDatabases)} Firestore databases (including (default)), exceeding the limit of ${String(MAX_CONFIGURED_FIRESTORE_DATABASES)} databases per project.`,
    );
  }
}

/** Resolve the `firestore` value of a `firebase.json` to the files each database gets. */
export function firestoreRulesConfig(
  firestore: unknown,
  options: FirestoreRulesConfigOptions = {},
): FirestoreRulesConfig {
  const resolveFile = options.resolveFile ?? ((file: string) => file);
  const isAbsent = firestore === undefined || firestore === null || typeof firestore !== 'object';
  if (isAbsent) {
    return { form: 'absent', databases: [fallbackDefault(resolveFile)], unresolved: [] };
  }
  if (!Array.isArray(firestore)) {
    const resolvedObject = objectConfig(asEntry(firestore), resolveFile);
    assertConfiguredDatabaseCap(resolvedObject.databases);
    return resolvedObject;
  }

  const databases: FirestoreDatabaseConfig[] = [];
  const unresolved: UnresolvedFirestoreTarget[] = [];
  let override: string | undefined;
  firestore.forEach((raw: unknown, index) => {
    const label = `firebase.json firestore[${String(index)}]`;
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
        const pending: UnresolvedFirestoreTarget = { target: entry.target, label };
        if (files.rulesFile !== undefined) {
          pending.rulesFile = files.rulesFile;
        }
        if (files.indexesFile !== undefined) {
          pending.indexesFile = files.indexesFile;
        }
        unresolved.push(pending);
        return;
      }
    } else if (nonEmptyString(entry.database)) {
      ids = [entry.database];
    } else {
      throw new Error(`${label}: Must supply either "target" or "databaseId" in firestore config`);
    }
    for (const id of ids) {
      const dbEntry: FirestoreDatabaseConfig = {
        database: normalizedDatabase(id),
        label,
        configured: files.rulesFile !== undefined,
      };
      if (files.rulesFile !== undefined) {
        dbEntry.rulesFile = files.rulesFile;
      }
      if (files.indexesFile !== undefined) {
        dbEntry.indexesFile = files.indexesFile;
      }
      addDatabase(databases, dbEntry);
    }
  });
  if (override !== undefined) {
    applyOverride(databases, override);
  }
  assertConfiguredDatabaseCap(databases);
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

/**
 * The entry whose rules pyric serves on `(default)`. Undefined when
 * `firebase.json` deploys nothing to `(default)` (for instance an array naming
 * only named databases, or an object naming another database).
 */
export function defaultFirestoreDatabase(
  config: FirestoreRulesConfig,
): FirestoreDatabaseConfig | undefined {
  return config.databases.find((entry) => entry.database === DEFAULT_FIRESTORE_DATABASE);
}

/** One warning per configured Firestore `database` value outside Firebase's naming rules. */
export function invalidFirestoreDatabaseWarnings(
  config: FirestoreRulesConfig,
  displayFile: (file: string) => string = (file) => file,
): string[] {
  const warnings: string[] = [];
  for (const entry of config.databases) {
    if (isValidFirestoreDatabaseConfigId(entry.database)) {
      continue;
    }
    let detail = `${entry.label} declares Firestore database "${entry.database}"`;
    if (entry.rulesFile !== undefined) {
      detail = `${entry.label} deploys ${displayFile(entry.rulesFile)} to Firestore database "${entry.database}"`;
    }
    warnings.push(
      `${detail}, which is not a valid Firestore database id (must be 4-63 lowercase letters, digits, or hyphens, starting with a letter, ending with a letter or digit, and not a UUID), so pyric does not declare or serve it.`,
    );
  }
  return warnings;
}

/**
 * Warnings for `firebase.json` Firestore entries that cannot be served:
 * invalid database ids (never declared; requests answer as missing) and
 * deploy targets `.firebaserc` did not resolve.
 */
export function unservedFirestoreDatabaseWarnings(
  config: FirestoreRulesConfig,
  displayFile: (file: string) => string = (file) => file,
): string[] {
  const invalidWarnings = invalidFirestoreDatabaseWarnings(config, displayFile);
  const targetWarnings = config.unresolved.map((entry) => {
    let what = 'its files';
    if (entry.rulesFile !== undefined) {
      what = displayFile(entry.rulesFile);
    }
    return `${entry.label} deploys ${what} to deploy target "${entry.target}", which .firebaserc does not map for this project, so pyric does not serve it.`;
  });
  return [...invalidWarnings, ...targetWarnings];
}
