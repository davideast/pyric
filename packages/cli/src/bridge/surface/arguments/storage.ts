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
  file: 'sourcePath',
  filePath: 'sourcePath',
  localPath: 'sourcePath',
  crossServiceIam: 'mode',
  bucketId: 'bucket',
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

/**
 * Every client-settable metadata field, which is what a metadata update
 * replaces. The upload path groups only the two an upload usually names; an
 * update reaches the caching and disposition fields too, because changing one
 * of those without rewriting the object is the whole reason the SDK has a
 * separate call for it.
 */
export const settableMetadata = z
  .object({
    contentType: z.string().optional().describe('MIME type stored with the object.'),
    customMetadata: z
      .record(z.string())
      .optional()
      .describe('Custom string metadata, replaced wholesale when supplied.'),
    cacheControl: z.string().optional().describe('Cache-Control header served with the object.'),
    contentDisposition: z
      .string()
      .optional()
      .describe('Content-Disposition header served with the object.'),
    contentEncoding: z
      .string()
      .optional()
      .describe('Content-Encoding header served with the object.'),
    contentLanguage: z
      .string()
      .optional()
      .describe('Content-Language header served with the object.'),
  })
  .describe('The client-settable metadata fields, as the SDK groups them.');

/** The two cross-service IAM postures a project's Storage service agent can be in. */
export const CROSS_SERVICE_IAM_MODES = ['granted', 'denied'] as const;

/**
 * The content type an object path's extension implies.
 *
 * An upload from a file names no content type most of the time, and an object
 * stored as `application/octet-stream` reads back wrong everywhere it is
 * served. The table is small on purpose: an extension that is not in it infers
 * nothing rather than guessing, and the caller names the type.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  wasm: 'application/wasm',
  webp: 'image/webp',
  xml: 'application/xml',
  zip: 'application/zip',
};

/** The content type an object path's extension implies, or null when none does. */
export function contentTypeForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
}

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
