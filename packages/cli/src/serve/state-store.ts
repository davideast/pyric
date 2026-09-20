/**
 * On-disk state store for `pyric dev --persist` — the substrate side of
 * flow doc section 3c ("persistence = an autosaved seed").
 *
 * The file is an ENVELOPE around controller, Auth and optional hosted Storage sections:
 *   - `firestore`: the `pyric/sandbox` persistence controller's own blob
 *     (`{version, savedAt, firestore: {path: fields}}`), stored verbatim as
 *     parsed JSON. The page's controller wrote it and will read it back
 *     through its own (de)serializer — wrapper types (Timestamp, Bytes, …)
 *     live as marker shapes and re-hydrate to class instances on restore.
 *     This store never interprets it.
 *   - `auth`: `{users: SeedUser[]}` — what `sandbox.exportUsers` emits and
 *     `sandbox.seedUsers` accepts.
 *   - `storage`: asynchronous hosted object snapshots, including bytes and
 *     complete stored metadata. Older files may omit this section.
 *
 * Everything is plain, diffable JSON on purpose: the persisted state
 * doubles as a context artifact agents can read and promote to a fixture
 * (`pyric snapshot`, plan P3).
 *
 * Durability stance (judgment zone 6, recorded): writes are atomic
 * (tmp + rename, same volume) so a crash never truncates the file. A
 * CORRUPT or version-mismatched file makes `load()` throw rather than
 * silently discarding user data — serve fails fast and tells the user to
 * inspect or delete it. Last-writer-wins between section writes is
 * accepted (single serve process, sync fs — effectively serialized).
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStateFile, StateFileError, STATE_FILE_VERSION, type PyricStateFile } from './state-file.js';
import { firestoreDocCount } from './state-summary.js';
export { firestoreDocCount } from './state-summary.js';
export { StateFileError, STATE_FILE_VERSION, EXPECTED_CONTROLLER_BLOB_VERSION } from './state-file.js';
export type { ExportedUsers, PyricStateFile } from './state-file.js';

export type StateSection = 'firestore' | 'auth' | 'storage';

export interface StateStore {
  /** The project directory this store persists for (for the
   *  promote-the-wrong-project guard). */
  projectDir: string;
  /** Absolute path of the state file. */
  path: string;
  /** Absolute path of the one-deep recovery backup (`state.json.bak`). */
  backupPath: string;
  /** Parsed envelope, or null when the file doesn't exist. Throws
   *  {@link StateFileError} on corrupt JSON or version mismatch —
   *  fail fast over silent data loss. */
  load(): PyricStateFile | null;
  readSection(section: StateSection): unknown | null;
  /** Read-modify-write the envelope; atomic tmp+rename. A firestore write
   *  that would collapse a non-empty doc set to empty first preserves the
   *  prior file as `.bak` (pre-mortem #2). Hosted writes await queued mutations
   *  and commit before their returned promise resolves. */
  writeSection(section: StateSection, value: unknown): void | Promise<void>;
  exists(): boolean;
}

export const STATE_RELATIVE_PATH = join('.pyric', 'state', 'state.json');

export function createStateStore(projectDir: string): StateStore {
  const path = join(projectDir, STATE_RELATIVE_PATH);
  const backupPath = `${path}.bak`;

  const load = (): PyricStateFile | null => {
    const hasNoStateFile = !existsSync(path);
    if (hasNoStateFile) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // JSON parser messages can quote private state; retain location and recovery guidance only.
      throw new StateFileError(
        `state file at ${path} is not valid JSON. ` +
          'Inspect or delete it to continue — pyric will not overwrite it silently.',
      );
    }
    return parseStateFile(parsed, path);
  };

  const writeAtomic = (file: { version: typeof STATE_FILE_VERSION; firestore: unknown; auth: unknown }): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    renameSync(tmp, path); // same volume — atomic replace
  };

  return {
    projectDir,
    path,
    backupPath,
    load,
    exists: () => existsSync(path),
    readSection(section) {
      return load()?.[section] ?? null;
    },
    writeSection(section, value) {
      const current = load() ?? { version: STATE_FILE_VERSION, firestore: null, auth: null };
      // Data-loss guard (flow doc section 3c / pre-mortem #2): a `sandbox.reset()`
      // makes the persistence controller flush EMPTY firestore over the
      // live file (pyric flushes on session_boundary by design), and the
      // backend write can't tell that from a legitimate delete-all. Before
      // a firestore write would collapse a NON-empty doc set to empty, keep
      // the prior file as `.bak` (one-deep) so it's recoverable. Intent-
      // agnostic on purpose — covers reset, agent error, and accidental
      // delete-all uniformly.
      const emptiesExistingDocuments = section === 'firestore'
        && firestoreDocCount(value) === 0
        && firestoreDocCount(current.firestore) > 0;
      const shouldPreserveBackup = emptiesExistingDocuments && existsSync(path);
      if (shouldPreserveBackup) {
        copyFileSync(path, backupPath);
      }
      writeAtomic({ ...current, [section]: value });
    },
  };
}
