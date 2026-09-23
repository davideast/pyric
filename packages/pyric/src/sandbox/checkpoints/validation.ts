import { z } from 'zod';
import { DOC_VALUE_ENCODING } from '../../firestore/internal/value-codec.js';
import { base64ToBytes } from '../../storage/base64.js';
import { normalizePath } from '../../storage/reference.js';
import { compileStorageRules } from '../../storage/rules-resolution.js';
import type { FullSandboxState, StorageObjectState } from '../full-state.js';
import { seedUserSchema, storedMetadataSchema } from '../internal/state-schemas.js';
import { decodeStateDocument } from '../internal/state-values.js';
import { SandboxError } from '../types/errors.js';

const storageFields = {
  path: z.string().min(1).refine(path => normalizePath(path) === path, 'Expected a canonical object path'),
  contentType: z.string().optional(),
  customMetadata: z.record(z.string()),
  metadata: storedMetadataSchema.omit({ fullPath: true, contentType: true, customMetadata: true }).optional(),
  blobType: z.string().optional(),
} satisfies Record<keyof StorageObjectState, z.ZodType<unknown>>;

/** A Storage entry carries its bytes inline, or names them by SHA-256 with its metadata. */
const storageObjectSchema = z.union([
  z.object({
    ...storageFields,
    contentBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      'Expected standard padded base64'),
  }),
  z.object({
    ...storageFields,
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest'),
    size: z.number().int().nonnegative(),
    metadata: storageFields.metadata.unwrap(),
  }),
]);

const databaseEnvelopeSchema = z.object({
  '.pyricRtdbPersistence': z.literal(1),
  data: z.unknown().refine(value => value !== undefined, 'Required'),
  priorities: z.record(z.union([z.string(), z.number().finite()])),
});

/** Legacy trees have no marker; a marked record must use the supported envelope. */
function hasSupportedDatabaseEnvelope(value: unknown): boolean {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isTreeValue = !isObject;
  if (isTreeValue) return value !== undefined;
  const hasMarker = '.pyricRtdbPersistence' in value;
  const isLegacyTree = !hasMarker;
  if (isLegacyTree) return true;
  return databaseEnvelopeSchema.safeParse(value).success;
}

const stateFields = {
  firestore: z.record(z.record(z.unknown())),
  firestoreEncoding: z.literal(DOC_VALUE_ENCODING).optional(),
  database: z.unknown().refine(hasSupportedDatabaseEnvelope, 'Invalid RTDB persistence envelope'),
  storage: z.array(storageObjectSchema),
  auth: z.object({ users: z.array(seedUserSchema), providers: z.record(z.boolean()) }),
  rules: z.object({
    firestore: z.string(),
    database: z.object({ rules: z.record(z.unknown()) }).nullable(),
    storage: z.string().nullable(),
  }),
  clock: z.object({ mode: z.enum(['wall', 'fixed', 'offset']),
    fixedAt: z.number().finite(), offsetMs: z.number().finite() }).optional(),
} satisfies Record<keyof FullSandboxState, z.ZodType<unknown>>;

const checkpointStateSchema = z.object(stateFields);

/** Validate serialized state and fallible service inputs before resetting healthy state. */
export function assertCheckpointState(state: unknown): void {
  const result = checkpointStateSchema.safeParse(state);
  const isInvalidState = !result.success;
  if (isInvalidState) {
    const details = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new SandboxError('invalid-argument', `Invalid checkpoint state (${details}).`);
  }
  try {
    for (const document of Object.values(result.data.firestore)) {
      decodeStateDocument(document, result.data.firestoreEncoding);
    }
  } catch (error) {
    throw new SandboxError('invalid-argument', `Invalid checkpoint Firestore values: ${String(error)}`);
  }
  for (const object of result.data.storage) {
    const declaredSize = object.metadata?.size;
    const isLegacyObject = declaredSize === undefined;
    if (isLegacyObject) continue;
    const actualSize = 'contentBase64' in object ? base64ToBytes(object.contentBase64).byteLength : object.size;
    const hasWrongSize = actualSize !== declaredSize;
    if (hasWrongSize) {
      throw new SandboxError('invalid-argument', `Invalid checkpoint Storage size for '${object.path}'.`);
    }
  }
  const storageRules = result.data.rules.storage;
  const hasStorageRules = storageRules !== null;
  if (hasStorageRules) {
    try {
      compileStorageRules(storageRules);
    } catch (error) {
      throw new SandboxError('invalid-argument', `Invalid checkpoint Storage rules: ${String(error)}`);
    }
  }
}
