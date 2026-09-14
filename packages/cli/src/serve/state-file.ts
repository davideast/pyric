import type { sandbox as authSandbox } from 'pyric/auth';
import { z } from 'zod';
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

// Keep every exported account field in the file codec. Extra fields are
// retained so reading a fixture does not silently discard its contents.
const userFields = {
  uid: z.string(),
  email: z.string().optional(),
  password: z.string().optional(),
  displayName: z.string().optional(),
  customClaims: z.record(z.unknown()).optional(),
  photoUrl: z.string().optional(),
  phoneNumber: z.string().optional(),
  emailVerified: z.boolean().optional(),
  disabled: z.boolean().optional(),
  tenantId: z.string().optional(),
  providerId: z.string().optional(),
} satisfies Record<keyof ExportedUsers[number], z.ZodType<unknown>>;

const storageMetadataFields = {
  fullPath: z.string(),
  name: z.string(),
  bucket: z.string(),
  generation: z.string(),
  metageneration: z.string(),
  timeCreated: z.string(),
  updated: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string().optional(),
  cacheControl: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentEncoding: z.string().optional(),
  contentLanguage: z.string().optional(),
  customMetadata: z.record(z.string()).optional(),
  md5Hash: z.string().optional(),
} satisfies Record<keyof StorageStateRecord['metadata'], z.ZodType<unknown>>;

const stateFileSchema = z.object({
  version: z.literal(STATE_FILE_VERSION),
  firestore: z.unknown().default(null),
  auth: z.object({ users: z.array(z.object(userFields).passthrough()) })
    .passthrough().nullable().default(null),
  storage: z.array(z.object({
    dataBase64: z.string(),
    blobType: z.string(),
    metadata: z.object(storageMetadataFields).passthrough(),
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
