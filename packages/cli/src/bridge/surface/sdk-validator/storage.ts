/**
 * The `storage` tool: the modular Cloud Storage SDK's method names, with a path
 * string standing in for the `StorageReference` a real call would carry and the
 * bytes carried base64 encoded, because a tool call is JSON.
 *
 * The encoding is the thing worth checking. A payload pasted raw looks like a
 * string either way, and an object stored from it is wrong in a way that only
 * shows up when something reads it back.
 */
import { z } from 'zod';
import type { Args, MethodSpec, ToolSpec } from './shared.js';
import { quoted } from './shared.js';

const RENAMES: Readonly<Record<string, string>> = {
  ref: 'path',
  reference: 'path',
  contentType: 'metadata.contentType',
  customMetadata: 'metadata.customMetadata',
  data: 'contentBase64',
  bytes: 'contentBase64',
  content: 'contentBase64',
  folder: 'prefix',
};

const pathArgument = z
  .string()
  .describe('Object path within the bucket, for example uploads/pic.png.');

const metadata = z
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
function decodes(value: string): boolean {
  if (value === '') return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch {
    return false;
  }
}

const METHODS: readonly MethodSpec[] = [
  {
    name: 'uploadBytes',
    sdkOrigin: 'firebase-js',
    signature: 'uploadBytes(path, contentBase64, metadata?)',
    summary: 'Store an object from base64-encoded bytes.',
    args: z.object({
      path: pathArgument,
      contentBase64: z.string().describe('Base64-encoded object payload.'),
      metadata,
    }),
    operations: ['upload_storage_file'],
    renames: RENAMES,
    example: {
      path: 'uploads/hello.txt',
      contentBase64: 'aGVsbG8=',
      metadata: { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
    },
    resolve: () => 'upload_storage_file',
    translate: (args) => {
      const supplied = (args.metadata ?? {}) as Args;
      const call: Args = { path: args.path, contentBase64: args.contentBase64 };
      if (supplied.contentType !== undefined) call.contentType = supplied.contentType;
      if (supplied.customMetadata !== undefined) call.metadata = supplied.customMetadata;
      return call;
    },
    check: (args, fail) => {
      const content = String(args.contentBase64);
      if (decodes(content)) return null;
      const shown = content.length > 40 ? `${content.slice(0, 40)}...` : content;
      return fail(
        `contentBase64 ${quoted(shown)} is not base64. uploadBytes carries the object bytes base64 encoded, because a tool call is JSON.`,
        `Pass contentBase64 as the payload, base64 encoded.`,
        'contentBase64',
      );
    },
  },
  {
    name: 'getBytes',
    sdkOrigin: 'firebase-js',
    signature: 'getBytes(path)',
    summary: 'Read one object back as base64-encoded bytes.',
    args: z.object({ path: pathArgument }),
    operations: ['download_storage_file'],
    renames: RENAMES,
    example: { path: 'uploads/hello.txt' },
    resolve: () => 'download_storage_file',
    translate: (args) => ({ path: args.path }),
  },
  {
    name: 'listAll',
    sdkOrigin: 'firebase-js',
    signature: 'listAll(prefix?)',
    summary: 'List the objects under a folder, or under the bucket root.',
    args: z.object({
      prefix: z.string().optional().describe('Folder path to list under. Defaults to the root.'),
    }),
    operations: ['list_storage_files'],
    renames: RENAMES,
    example: { prefix: 'uploads' },
    resolve: () => 'list_storage_files',
    translate: (args) => (args.prefix === undefined ? {} : { prefix: args.prefix }),
  },
  {
    name: 'getMetadata',
    sdkOrigin: 'firebase-js',
    signature: 'getMetadata(path)',
    summary: 'Read one object size, content type, and custom metadata.',
    args: z.object({ path: pathArgument }),
    operations: ['get_storage_metadata'],
    renames: RENAMES,
    example: { path: 'uploads/hello.txt' },
    resolve: () => 'get_storage_metadata',
    translate: (args) => ({ path: args.path }),
  },
  {
    name: 'deleteObject',
    sdkOrigin: 'firebase-js',
    signature: 'deleteObject(path)',
    summary: 'Delete one object.',
    args: z.object({ path: pathArgument }),
    operations: ['delete_storage_file'],
    renames: RENAMES,
    example: { path: 'uploads/hello.txt' },
    resolve: () => 'delete_storage_file',
    translate: (args) => ({ path: args.path }),
  },
];

export const STORAGE_TOOL: ToolSpec = {
  name: 'storage',
  intro:
    'Cloud Storage in the sandbox, called with the modular SDK method names and argument names. A reference is an object path within the bucket, and bytes travel base64 encoded.',
  methods: METHODS,
};
