import type { sandbox as authSandbox } from 'pyric/auth';
import { z } from 'zod';
import { seedUserSchema, storedMetadataSchema } from 'pyric/sandbox/internal';
import type { StorageStateRecord } from 'pyric/storage/internal';

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
  storage?: StorageStateRecord[];
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
  storage: z.array(z.object({
    dataBase64: z.string(),
    blobType: z.string(),
    metadata: storedMetadataSchema,
  })).optional(),
}).passthrough();

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
      `state file at ${source} has version ${String(version)}; this @pyric/cli expects ` +
      `${STATE_FILE_VERSION}. Delete it (or promote it with a matching @pyric/cli) to continue.`,
    );
  }

  const result = stateFileSchema.safeParse(value);
  const isInvalidState = !result.success;
  if (isInvalidState) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new StateFileError(`state file at ${source} is invalid (${details}).`);
  }

  const file = result.data;
  const firestore = file.firestore;
  const hasControllerVersion = firestore !== null && typeof firestore === 'object' && 'version' in firestore;
  const innerVersion = hasControllerVersion ? firestore.version : undefined;
  const isUnsupportedController = innerVersion !== undefined && innerVersion !== EXPECTED_CONTROLLER_BLOB_VERSION;
  if (isUnsupportedController) {
    throw new StateFileError(
      `state file at ${source} holds a firestore blob of version ${String(innerVersion)}; this ` +
      `pyric expects ${EXPECTED_CONTROLLER_BLOB_VERSION} (pyric was likely upgraded). ` +
      'Delete the state file or re-promote it with a matching pyric to continue.',
    );
  }
  return { ...file, firestore: file.firestore ?? null };
}
