import type { sandbox as authSandbox } from 'pyric/auth';
import { join } from 'node:path';
import { z } from 'zod';
import { seedUserSchema, storedMetadataSchema } from 'pyric/sandbox/internal';
import type { StoredMetadata, StorageStateRecord } from 'pyric/storage/internal';

export type ExportedUsers = ReturnType<typeof authSandbox.exportUsers>;
export const STATE_FILE_VERSION = 1 as const;

/** Mirrors the persistence controller's SCHEMA_VERSION; the packages ship together. */
export const EXPECTED_CONTROLLER_BLOB_VERSION = 1;

export interface PyricStateFile {
  version: typeof STATE_FILE_VERSION;
  /** Opaque persistence-controller data; only its version is inspected here. */
  firestore: unknown;
  auth: { users: ExportedUsers } | null;
  /** Hosted Storage has asynchronous snapshots, separate from controller records. */
  storage?: StorageStateEntry[];
}

/**
 * A Storage object in a state document whose bytes are the file
 * `objects/<ab>/<sha256>` beside the document, not a string inside it.
 */
export interface StorageObjectReference {
  /** The object's path in its bucket. */
  path: string;
  sha256: string;
  size: number;
  blobType: string;
  metadata: StoredMetadata;
}

/** A Storage entry as a document carries it: bytes inline, or a reference to a file. */
export type StorageStateEntry = StorageStateRecord | StorageObjectReference;

export function isStorageReference(entry: StorageStateEntry): entry is StorageObjectReference {
  return 'sha256' in entry;
}

/** Where a document in `directory` keeps the bytes of the object with this hash. */
export function objectFileIn(directory: string, sha256: string): string {
  return join(directory, 'objects', sha256.slice(0, 2), sha256);
}

export class StateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFileError';
  }
}

const stateFileSchema = z.object({
  version: z.literal(STATE_FILE_VERSION),
  firestore: z.unknown().default(null),
  auth: z.object({ users: z.array(seedUserSchema) })
    .passthrough().nullable().default(null),
  storage: z.array(z.union([
    z.object({
      dataBase64: z.string(),
      blobType: z.string(),
      metadata: storedMetadataSchema,
    }),
    z.object({
      path: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().nonnegative(),
      blobType: z.string(),
      metadata: storedMetadataSchema,
    }).refine(entry => entry.path === entry.metadata.fullPath && entry.size === entry.metadata.size),
  ])).optional(),
}).passthrough();

function diagnosticVersion(value: unknown): string {
  const isVersionNumber = typeof value === 'number' && Number.isSafeInteger(value);
  return isVersionNumber ? String(value) : '(invalid)';
}

/** Validate both promoted seed fixtures and restored files before using their records. */
export function parseStateFile(value: unknown, source: string): PyricStateFile {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isInvalidEnvelope = !isObject;
  if (isInvalidEnvelope) throw new StateFileError(`state file at ${source} is not an object.`);

  const hasVersion = 'version' in value;
  const version = hasVersion ? value.version : undefined;
  const isUnsupportedVersion = version !== STATE_FILE_VERSION;
  if (isUnsupportedVersion) {
    throw new StateFileError(
      `state file at ${source} has version ${diagnosticVersion(version)}; this @pyric/cli expects ` +
      `${STATE_FILE_VERSION}. Delete it (or promote it with a matching @pyric/cli) to continue.`,
    );
  }

  const result = stateFileSchema.safeParse(value);
  const isInvalidState = !result.success;
  if (isInvalidState) {
    throw new StateFileError(`state file at ${source} has invalid Auth or Storage records. Inspect or repair the file before restarting; no records were imported.`);
  }

  const file = result.data;
  const firestore = file.firestore;
  const hasControllerVersion = firestore !== null && typeof firestore === 'object' && 'version' in firestore;
  const innerVersion = hasControllerVersion ? firestore.version : undefined;
  const isUnsupportedController = innerVersion !== undefined && innerVersion !== EXPECTED_CONTROLLER_BLOB_VERSION;
  if (isUnsupportedController) {
    throw new StateFileError(
      `state file at ${source} holds a firestore blob of version ${diagnosticVersion(innerVersion)}; this ` +
      `pyric expects ${EXPECTED_CONTROLLER_BLOB_VERSION} (pyric was likely upgraded). ` +
      'Delete the state file or re-promote it with a matching pyric to continue.',
    );
  }
  return { ...file, firestore: file.firestore ?? null };
}
