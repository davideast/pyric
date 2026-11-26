import { z } from 'zod';
import type { SeedUser } from '../../auth/seed-user.js';
import type { StoredMetadata } from '../../storage/persistence.js';

// Keep every exported account field in the file codec. Extra fields are
// retained so reading a fixture does not silently discard its contents.
const userFields = {
  uid: z.string(),
  createdAt: z.string().optional(),
  lastLoginAt: z.string().nullable().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  displayName: z.string().optional(),
  customClaims: z.record(z.string(), z.unknown()).optional(),
  photoUrl: z.string().optional(),
  phoneNumber: z.string().optional(),
  emailVerified: z.boolean().optional(),
  disabled: z.boolean().optional(),
  tenantId: z.string().optional(),
  providerId: z.string().optional(),
  providerUserInfo: z.array(z.object({ providerId: z.string() })).optional(),
} satisfies Record<keyof SeedUser, z.ZodType<unknown>>;

/**
 * Validate a plain string-value map while preserving own `"__proto__"` keys
 * via `Object.defineProperty` (Zod's `z.record` assigns via `[]` and drops them).
 */
const customMetadataSchema: z.ZodType<Record<string, string>> = z
  .custom<Record<string, string>>(
    (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
      }
      for (const key of Object.keys(value)) {
        if (typeof (value as Record<string, unknown>)[key] !== 'string') {
          return false;
        }
      }
      return true;
    },
    { message: 'Expected customMetadata to be an object mapping strings to strings' },
  )
  .transform((value) => {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  });

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
  customMetadata: customMetadataSchema.optional(),
  downloadTokens: z.string().optional(),
  md5Hash: z.string().optional(),
  crc32c: z.string().optional(),
  etag: z.string().optional(),
} satisfies Record<keyof StoredMetadata, z.ZodType<unknown>>;

/** Shared account file shape used by checkpoints and host state. */
export const seedUserSchema = z.looseObject(userFields);

/** Complete stored object metadata shared by state readers. */
export const storedMetadataSchema = z.looseObject(storageMetadataFields);
