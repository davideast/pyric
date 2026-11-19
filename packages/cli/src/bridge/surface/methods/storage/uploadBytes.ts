/** Store one Cloud Storage object from a base64 payload or from a file in the project. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ref, uploadBytes } from 'pyric/storage';
import {
  bucketArgument,
  checkBucket,
  contentTypeForPath,
  decodesAsBase64,
  metadata,
  pathArgument,
  RENAMES,
} from '../../arguments/storage.js';
import { projectPathWithin } from '../../arguments/sandbox.js';
import { failFor } from '../../method-validation.js';
import { operationFailure } from '../../context.js';
import { decodeBase64 } from '../../service-handles.js';
import { onBucket, selectedStorageBucket, storageAtBucket } from '../../storage-bucket.js';
import { quoted } from '../../closest-name.js';
import type { Args, InvalidArguments, MethodRecord, MethodValidationContext } from '../../method-types.js';
import type { SurfaceContext } from '../../types.js';

/** The rejection this method builds, bound to its own tool and method. */
const fail = failFor('storage', 'uploadBytes');

/** Refuse a call that named both payload forms, or neither. */
function refuseAmbiguousSource(args: Args, ctx: MethodValidationContext): InvalidArguments | null {
  const named = args.contentBase64 !== undefined;
  const sourced = args.sourcePath !== undefined;
  if (named && sourced) {
    return ctx.fail(
      'both contentBase64 and sourcePath were passed, and an upload carries one payload.',
      'Pass contentBase64 for bytes the call already holds, or sourcePath for a file in the project directory.',
      'contentBase64',
    );
  }
  if (!named && !sourced) {
    return ctx.fail(
      'neither contentBase64 nor sourcePath was passed, so the upload has no payload.',
      'Pass contentBase64 as the payload, base64 encoded, or sourcePath as a file in the project directory.',
      'contentBase64',
    );
  }
  return null;
}

/** The metadata an upload settles on, with the extension filling in an unnamed type. */
function metadataFor(
  supplied: Args,
  path: string,
): { contentType?: string; customMetadata?: Record<string, string> } {
  const settable: { contentType?: string; customMetadata?: Record<string, string> } = {};
  const inferred = contentTypeForPath(path);
  if (supplied.contentType !== undefined) {
    settable.contentType = String(supplied.contentType);
  } else if (inferred !== null) {
    settable.contentType = inferred;
  }
  if (supplied.customMetadata !== undefined) {
    settable.customMetadata = supplied.customMetadata as Record<string, string>;
  }
  return settable;
}

/** The bytes this call uploads, or the refusal the caller is handed instead. */
function payloadFor(args: Args, ctx: SurfaceContext): Uint8Array | InvalidArguments {
  if (args.sourcePath === undefined) return decodeBase64(String(args.contentBase64));
  const given = String(args.sourcePath);
  const resolved = projectPathWithin(ctx.projectDir, given, 'sourcePath', fail);
  if (!('path' in resolved)) return resolved;
  return new Uint8Array(readFileSync(resolved.path));
}

export default {
  tool: 'storage',
  method: 'uploadBytes',
  runsIn: 'bridge',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'uploadBytes(path, contentBase64? | sourcePath?, metadata?, bucket?)',
  description:
    'Store an object from base64-encoded bytes or from sourcePath inside the project directory, not both. The path extension supplies an unnamed contentType.',
  args: z.object({
    path: pathArgument,
    contentBase64: z.string().optional().describe('Base64-encoded object payload.'),
    sourcePath: z
      .string()
      .optional()
      .describe('Path of a file inside the project directory whose bytes are uploaded.'),
    metadata,
    bucket: bucketArgument,
  }),
  operation: 'upload_storage_file',
  renames: RENAMES,
  example: {
    path: 'uploads/hello.txt',
    contentBase64: 'aGVsbG8=',
    metadata: { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
  },
  validate: (args, ctx) => {
    const ambiguous = refuseAmbiguousSource(args, ctx);
    if (ambiguous !== null) return ambiguous;
    if (args.contentBase64 !== undefined) {
      const content = String(args.contentBase64);
      if (!decodesAsBase64(content)) {
        let shown = content;
        if (content.length > 40) {
          shown = `${content.slice(0, 40)}...`;
        }
        return ctx.fail(
          `contentBase64 ${quoted(shown)} is not base64. uploadBytes carries the object bytes base64 encoded, because a tool call is JSON.`,
          `Pass contentBase64 as the payload, base64 encoded.`,
          'contentBase64',
        );
      }
    }
    return checkBucket(args, ctx.fail);
  },
  async handler(args, ctx) {
    const path = String(args.path);
    const rawMetadata = (args.metadata ?? {}) as Args;
    const settable = metadataFor(rawMetadata, path);
    const selector = selectedStorageBucket(ctx, args.bucket);

    let bytes: Uint8Array;
    try {
      const payload = payloadFor(args, ctx);
      if (!(payload instanceof Uint8Array)) return payload;
      bytes = payload;
    } catch {
      return operationFailure(`No file to upload at '${String(args.sourcePath)}'.`);
    }

    const result = await uploadBytes(ref(storageAtBucket(ctx, selector), path), bytes, settable);
    return {
      ok: true,
      summary: onBucket(`Uploaded ${path} (${bytes.byteLength} bytes)`, selector),
      data: {
        path,
        size: result.metadata.size,
        contentType: result.metadata.contentType,
      },
    };
  },
} satisfies MethodRecord;
