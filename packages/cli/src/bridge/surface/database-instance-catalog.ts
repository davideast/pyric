/**
 * The Realtime Database instances a `database` method may name.
 *
 * An instance is known when `firebase.json` declares it or the sandbox already
 * holds data for it, because an app can open an instance `firebase.json` never
 * names. A host builds its catalog from the instances it serves
 * (`serve/worker/host/rtdb-instance-catalog.ts`); the in-process sandbox and
 * the CLI runner read the project's files (`./database-instance-project.ts`).
 * This module reads no files, so a host in a browser can import it.
 */
import { isDefaultDatabaseInstance } from 'pyric/sandbox/internal';

/** The instances a caller may name, as the refusal lists them. */
export interface KnownDatabaseInstances {
  /** The default instance's name, when the project names one. */
  defaultInstance?: string;
  /** Every other instance, declared first, then held. */
  named: string[];
  /** Why a `firebase.json` target selects no instance yet, one sentence each. */
  pending: string[];
}

export interface DatabaseInstanceCatalog {
  /**
   * The `getDatabase` selector for an instance name: `undefined` for the
   * default instance, the name for a known instance, and `null` when the
   * project has no such instance.
   */
  select(name: string): string | undefined | null;
  known(): KnownDatabaseInstances;
}

/**
 * Build a catalog from the default instance's name and the named instances.
 * `projectId`, when known, also names the default instance, as
 * `https://<projectId>.firebaseio.com` does for a project created before about 2020.
 */
export function databaseInstanceCatalog(known: KnownDatabaseInstances, projectId?: string): DatabaseInstanceCatalog {
  return {
    select(name) {
      if (name === known.defaultInstance || isDefaultDatabaseInstance(name, projectId)) return undefined;
      return known.named.includes(name) ? name : null;
    },
    known: () => known,
  };
}

/** The names in `names`, each once, in first-seen order, without `exclude`. */
export function distinctNames(names: readonly string[], exclude: string | undefined): string[] {
  return [...new Set(names)].filter((name) => name !== exclude);
}
