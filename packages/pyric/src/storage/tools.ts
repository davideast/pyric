/**
 * Tool factories for `pyric/storage` data-plane operations.
 *
 * `createStorageDataTools({ resolveStorage })` wraps the modular Web-SDK
 * Storage surface as `ToolHandler[]`: upload, download, list, metadata and
 * delete. The resolver returns either an admin-bypass `FirebaseStorage` or a
 * rules-enforcing one acting as a specific user, mirroring the `resolveDb`
 * pattern in `pyric/firestore`'s tool factory (F2 + F4).
 */
import type { ToolHandler } from '@inbrowser/agent';
import { ref } from './reference.js';
import { uploadBytes, decodeString, defaultRawContentType, type StringFormat } from './upload.js';
import { getMetadata, updateMetadata, type SettableMetadata, type FullMetadata } from './metadata.js';
import { listAll } from './list.js';
import { getBytes, deleteObject } from './download.js';
import type { FirebaseStorage } from './service.js';

export interface UserAuth {
  uid: string;
  claims?: Record<string, unknown>;
}

/**
 * Who a data-plane op runs as. The default (omitted, or the literal `'admin'`)
 * is an ADMIN write that BYPASSES rules — the right mode for sandbox seeding.
 * A `{ uid, claims? }` runs as that user with rules ENFORCED.
 */
export type As = 'admin' | UserAuth;

/** JSONSchema for the `as` arg: the string `'admin'` OR `{ uid, claims? }`. */
const AS_SCHEMA = {
  description:
    "Identity to act as. Omit or 'admin' = admin write that BYPASSES rules (sandbox seeding). { uid, claims? } = act as that user with rules ENFORCED.",
  oneOf: [
    { type: 'string' as const, enum: ['admin'] },
    {
      type: 'object' as const,
      properties: {
        uid: { type: 'string' as const },
        claims: { type: 'object' as const, description: 'Custom claims forwarded to the rule context (request.auth.token).' },
      },
      required: ['uid'],
    },
  ],
};

const STRING_FORMATS = ['raw', 'base64', 'data_url'] as const;

const CUSTOM_METADATA_SCHEMA = {
  type: 'object' as const,
  additionalProperties: { type: 'string' as const },
  description: 'Arbitrary string key/value pairs stored alongside the object.',
};

/** 1 MiB — the cap this tool enforces on a decoded upload payload. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/** 64 KiB — the default cap on a download preview; pass `full:true` to lift it. */
const DEFAULT_DOWNLOAD_PREVIEW_BYTES = 64 * 1024;

export interface StorageDataToolDeps {
  /**
   * Resolver returning a `FirebaseStorage` handle. Called per-dispatch with
   * the op's `as` value: `'admin'` (or undefined) → an admin-bypass handle;
   * `{ uid, claims? }` → a rules-enforcing handle acting as that user.
   */
  resolveStorage(as?: As): Promise<FirebaseStorage> | FirebaseStorage;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function looksTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type === 'application/xml' || type.endsWith('+xml');
}

/**
 * Modular Web-SDK-shaped Storage data tools — upload, download, list,
 * metadata, delete. Each tool's `as` arg is forwarded to the resolver;
 * omitted = admin mode, supplied = user mode with rules enforced.
 */
export function createStorageDataTools(deps: StorageDataToolDeps): ToolHandler[] {
  const { resolveStorage } = deps;
  return [
    {
      name: 'storage_upload_object',
      description:
        'Upload an object to Cloud Storage. Payload is either `text` (interpreted per `format`: raw text, base64, or a data URI) or `dataUrl` (a `data:` URI, format inferred from its prefix) — exactly one of the two is required. Decoded payload is capped at 1 MiB (1,048,576 bytes); larger input returns a structured error instead of writing. Admin by default; pass `as:{uid}` to write as that user with rules enforced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Object path, e.g. "avatars/alice.png". Must be non-empty (root is not a valid object path).' },
          text: { type: 'string', description: 'Payload, decoded per `format` (default "raw"). Required unless `dataUrl` is supplied.' },
          format: { type: 'string', enum: [...STRING_FORMATS], description: 'How to decode `text`. Default "raw".' },
          dataUrl: { type: 'string', description: 'A `data:` URI carrying both MIME type and payload. Alternative to `text` + `format`.' },
          contentType: { type: 'string', description: 'Overrides the inferred content type.' },
          customMetadata: CUSTOM_METADATA_SCHEMA,
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as {
          path: string;
          text?: string;
          format?: StringFormat;
          dataUrl?: string;
          contentType?: string;
          customMetadata?: Record<string, string>;
          as?: As;
        };
        const hasText = a.text !== undefined;
        const hasDataUrl = a.dataUrl !== undefined;
        if (hasText === hasDataUrl) {
          return {
            ok: false,
            summary: `storage_upload_object: supply exactly one of "text" or "dataUrl" for ${a.path}.`,
          };
        }
        const format: StringFormat = hasDataUrl ? 'data_url' : (a.format ?? 'raw');
        const payload = hasDataUrl ? a.dataUrl! : a.text!;
        const { bytes, inferredType } = decodeString(payload, format);
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          return {
            ok: false,
            summary: `storage_upload_object: decoded payload for ${a.path} is ${bytes.byteLength} bytes, exceeds the ${MAX_UPLOAD_BYTES}-byte (1 MiB) cap.`,
            data: { code: 'size_exceeded', maxBytes: MAX_UPLOAD_BYTES, actualBytes: bytes.byteLength },
          };
        }
        const storage = await resolveStorage(a.as);
        const objectRef = ref(storage, a.path);
        const settable: SettableMetadata = {
          contentType: a.contentType ?? inferredType ?? defaultRawContentType(format),
          customMetadata: a.customMetadata,
        };
        const result = await uploadBytes(objectRef, bytes, settable);
        return {
          ok: true,
          summary: `Uploaded ${bytes.byteLength} byte(s) to ${a.path}`,
          data: { path: result.ref.fullPath, metadata: result.metadata },
        };
      },
    },
    {
      name: 'storage_download_object',
      description:
        'Download an object and return its metadata plus a preview of its content, either as text or base64 (auto-selected from the content type unless `encoding` is given). The preview is capped at 64 KiB by default; pass `full:true` to return the entire object. Admin by default; pass `as:{uid}` to read with rules enforced as that user.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          full: { type: 'boolean', description: 'Return the entire object instead of the 64 KiB preview. Default false.' },
          encoding: { type: 'string', enum: ['text', 'base64'], description: 'Force the preview encoding. Default: text for textual content types, base64 otherwise.' },
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; full?: boolean; encoding?: 'text' | 'base64'; as?: As };
        const storage = await resolveStorage(a.as);
        const objectRef = ref(storage, a.path);
        const metadata: FullMetadata = await getMetadata(objectRef);
        const buffer = await getBytes(objectRef);
        const all = new Uint8Array(buffer);
        const cap = a.full ? all.byteLength : DEFAULT_DOWNLOAD_PREVIEW_BYTES;
        const truncatedBytes = all.byteLength > cap ? all.slice(0, cap) : all;
        const truncated = truncatedBytes.byteLength < all.byteLength;
        const encoding = a.encoding ?? (looksTextual(metadata.contentType) ? 'text' : 'base64');
        const preview =
          encoding === 'text' ? new TextDecoder().decode(truncatedBytes) : bytesToBase64(truncatedBytes);
        return {
          ok: true,
          summary: `${a.path}: ${all.byteLength} byte(s), ${metadata.contentType ?? 'unknown type'}${truncated ? `, preview truncated to ${truncatedBytes.byteLength}` : ''}`,
          data: {
            metadata,
            preview: { encoding, content: preview, previewBytes: truncatedBytes.byteLength, totalBytes: all.byteLength, truncated },
          },
        };
      },
    },
    {
      name: 'storage_list_objects',
      description:
        'List the immediate items and sub-prefixes under a prefix (non-recursive, mirrors `listAll`). Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Prefix to scan. Omit or "" for the bucket root.' },
          as: AS_SCHEMA,
        },
      },
      async execute(args) {
        const a = args as { prefix?: string; as?: As };
        const storage = await resolveStorage(a.as);
        const objectRef = ref(storage, a.prefix ?? '');
        const result = await listAll(objectRef);
        return {
          ok: true,
          summary: `${result.items.length} item(s), ${result.prefixes.length} prefix(es) under "${a.prefix ?? ''}"`,
          data: {
            items: result.items.map((item) => ({ path: item.fullPath, name: item.name })),
            prefixes: result.prefixes.map((prefix) => ({ path: prefix.fullPath, name: prefix.name })),
          },
        };
      },
    },
    {
      name: 'storage_object_metadata',
      description:
        'Get an object\'s metadata, or update its client-settable fields when `set` is supplied (merges; a field omitted from `set` is left unchanged). Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          set: {
            type: 'object',
            description: 'Client-settable metadata patch. Supplying this updates instead of reads.',
            properties: {
              contentType: { type: 'string' },
              cacheControl: { type: 'string' },
              contentDisposition: { type: 'string' },
              contentEncoding: { type: 'string' },
              contentLanguage: { type: 'string' },
              customMetadata: CUSTOM_METADATA_SCHEMA,
            },
          },
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; set?: SettableMetadata; as?: As };
        const storage = await resolveStorage(a.as);
        const objectRef = ref(storage, a.path);
        const metadata = a.set ? await updateMetadata(objectRef, a.set) : await getMetadata(objectRef);
        return {
          ok: true,
          summary: `${a.set ? 'Updated' : 'Got'} metadata for ${a.path}`,
          data: { metadata },
        };
      },
    },
    {
      name: 'storage_delete_object',
      description: 'Delete an object. Admin by default; pass `as:{uid}` to enforce rules.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          as: AS_SCHEMA,
        },
        required: ['path'],
      },
      async execute(args) {
        const a = args as { path: string; as?: As };
        const storage = await resolveStorage(a.as);
        const objectRef = ref(storage, a.path);
        await deleteObject(objectRef);
        return { ok: true, summary: `Deleted ${a.path}` };
      },
    },
  ];
}
