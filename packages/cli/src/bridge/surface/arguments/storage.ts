/**
 * The `storage` tool's argument vocabulary.
 *
 * The encoding is the thing worth checking. A payload pasted raw looks like a
 * string either way, and an object stored from it is wrong in a way that only
 * shows up when something reads it back.
 */
import { z } from 'zod';

export const RENAMES: Readonly<Record<string, string>> = {
  ref: 'path',
  reference: 'path',
  contentType: 'metadata.contentType',
  customMetadata: 'metadata.customMetadata',
  data: 'contentBase64',
  bytes: 'contentBase64',
  content: 'contentBase64',
  folder: 'prefix',
};

export const pathArgument = z
  .string()
  .describe('Object path within the bucket, for example uploads/pic.png.');

/** Object metadata, as the SDK groups it. */
export const metadata = z
  .object({
    contentType: z.string().optional().describe('MIME type stored with the object.'),
    customMetadata: z
      .record(z.string())
      .optional()
      .describe('Custom string metadata stored with the object.'),
  })
  .optional()
  .describe('Object metadata, as the SDK groups it.');

/** Whether a string round trips through base64, which is what the sandbox stores. */
export function decodesAsBase64(value: string): boolean {
  if (value === '') return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return (
      Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') ===
      value.replace(/=+$/, '')
    );
  } catch {
    return false;
  }
}
