/**
 * On-disk state store for `pyric dev --persist` — the substrate side of
 * flow doc section 3c ("persistence = an autosaved seed").
 *
 * The file is an ENVELOPE around two sections:
 *   - `firestore`: the `pyric/sandbox` persistence controller's own blob
 *     (`{version, savedAt, firestore: {path: fields}}`), stored verbatim as
 *     parsed JSON. The page's controller wrote it and will read it back
 *     through its own (de)serializer — wrapper types (Timestamp, Bytes, …)
 *     live as marker shapes and re-hydrate to class instances on restore.
 *     This store never interprets it.
 *   - `auth`: `{users: SeedUser[]}` — what `sandbox.exportUsers` emits and
 *     `sandbox.seedUsers` accepts.
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
import type { sandbox as authSandbox } from 'pyric/auth';

export type ExportedUsers = ReturnType<typeof authSandbox.exportUsers>;

export const STATE_FILE_VERSION = 1 as const;

/** Expected inner version of the sandbox persistence controller's blob.
 *  MIRRORS pyric's `serialize.ts` `SCHEMA_VERSION` — bump in lockstep when
 *  pyric does (they ship together). Drift-risk noted: not importable
 *  (pyric doesn't export it), so a check, not a re-use. */
export const EXPECTED_CONTROLLER_BLOB_VERSION = 1;

export interface PyricStateFile {
  version: typeof STATE_FILE_VERSION;
  /** The sandbox persistence controller's blob, verbatim. Null = never flushed. */
  firestore: unknown | null;
  auth: { users: ExportedUsers } | null;
}

export type StateSection = 'firestore' | 'auth';

export class StateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFileError';
  }
}

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
   *  prior file as `.bak` (pre-mortem #2). */
  writeSection(section: StateSection, value: unknown): void;
  exists(): boolean;
}

export const STATE_RELATIVE_PATH = join('.pyric', 'state', 'state.json');

export function createStateStore(projectDir: string): StateStore {
  const path = join(projectDir, STATE_RELATIVE_PATH);
  const backupPath = `${path}.bak`;

  const load = (): PyricStateFile | null => {
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new StateFileError(
        `state file at ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
          'Inspect or delete it to continue — pyric will not overwrite it silently.',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StateFileError(`state file at ${path} is not an object.`);
    }
    const file = parsed as PyricStateFile;
    if (file.version !== STATE_FILE_VERSION) {
      throw new StateFileError(
        `state file at ${path} has version ${String(file.version)}; this pyric-tools expects ` +
          `${STATE_FILE_VERSION}. Delete it (or promote it with a matching pyric-tools) to continue.`,
      );
    }
    // Inner controller-blob version (pre-mortem #6): the page's
    // `deserializeSnapshot` validates this at restore — so a pyric upgrade
    // that bumps its SCHEMA_VERSION would otherwise fail IN THE PAGE while
    // the banner cheerfully reports "N docs restored". Peek it server-side
    // and fail fast here instead. (Read-only peek; the section is still
    // never re-encoded.) EXPECTED_CONTROLLER_BLOB_VERSION mirrors pyric's
    // serialize `SCHEMA_VERSION` and must bump in lockstep — they ship
    // together in this monorepo.
    const inner = (file.firestore as { version?: unknown } | null)?.version;
    if (inner !== undefined && inner !== EXPECTED_CONTROLLER_BLOB_VERSION) {
      throw new StateFileError(
        `state file at ${path} holds a firestore blob of version ${String(inner)}; this ` +
          `pyric expects ${EXPECTED_CONTROLLER_BLOB_VERSION} (pyric was likely upgraded). ` +
          'Delete the state file or re-promote it with a matching pyric to continue.',
      );
    }
    return file;
  };

  const writeAtomic = (file: PyricStateFile): void => {
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
      if (
        section === 'firestore' &&
        firestoreDocCount(value) === 0 &&
        firestoreDocCount(current.firestore) > 0 &&
        existsSync(path)
      ) {
        copyFileSync(path, backupPath);
      }
      writeAtomic({ ...current, [section]: value } as PyricStateFile);
    },
  };
}

/** Doc count inside a controller firestore blob (`{…, firestore: {path:
 *  fields}}`), 0 for null/empty/malformed. */
export function firestoreDocCount(section: unknown): number {
  const docs = (section as { firestore?: Record<string, unknown> } | null)?.firestore;
  return docs && typeof docs === 'object' ? Object.keys(docs).length : 0;
}
