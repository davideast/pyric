/**
 * What the live-storage row knows about `firebase/storage`: which calls reach
 * production, where a call's app, bucket and path sit on the SDK's own
 * reference, and how `getStream`'s stream is followed.
 *
 * The observed calls are the ones the sandbox's own Storage records
 * (`packages/pyric/src/storage/observed.ts`), so a row reads the same in
 * sandbox and live mode. Each takes a reference first, and the row reads it
 * through the SDK's public API only: the app from `ref.storage.app`, whose
 * Auth names the account (`account.ts`), the bucket from `ref.bucket`, and
 * the path from `ref.fullPath`. A root reference has no path, so its record
 * names none.
 *
 * The SDK calls its own functions through its own bindings (`listAll` pages
 * through its internal `list`, `uploadString` writes through its internal
 * `uploadBytes`), so each call the app makes is one record.
 *
 * `uploadBytesResumable` returns the SDK's own UploadTask: `instanceof`,
 * `on`, `pause`, `resume`, `cancel` and `snapshot` are the SDK's. Its `then`
 * and `catch` follow a promise that records the task's settlement once: ok,
 * production's denial, or `storage/canceled`. Progress is not recorded. The
 * SDK handles its own promise's rejection, so the followed promise is
 * handled too, and an app that only calls `task.on(...)` sees no unhandled
 * rejection.
 *
 * Every Storage export checks its arguments before any request and throws
 * synchronously when they fail (a root reference, a bad argument, the Node
 * build's `getBlob`). That throw is the SDK's, never production's answer, so
 * it reaches the app and makes no record.
 *
 * Reading never calls the app's code and never throws: a reference without
 * these shapes gives a record without its project, account or path, and with
 * the unread bucket. This file imports no Firebase SDK.
 */
import { observedCall, type CallContext, type ObservedSite, type ResultReading } from './observe.js';

type Callback = (this: unknown, ...values: unknown[]) => unknown;
type Fields = Record<string, unknown>;
type Site = Omit<ObservedSite, 'name'>;

/** The one-shot Storage calls the row observes. `getStream`, whose result is a stream, is the row's own (`observedGetStream`). */
export const STORAGE_CALLS = [
  'uploadBytes',
  'uploadString',
  'uploadBytesResumable',
  'getDownloadURL',
  'getBytes',
  'getBlob',
  'getMetadata',
  'updateMetadata',
  'list',
  'listAll',
  'deleteObject',
] as const;

/** The bucket names a host takes: a bare name, never a `gs://` URL, as `readObservedCall` checks it. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

/**
 * The bucket a record names when the reference does not say, or names one a
 * host would refuse. A host requires a bucket on every Storage call, so the
 * call still reaches Traffic, and reads this name as "no bucket named". This
 * runs in the page, which cannot import the host's contract
 * (`UNREAD_BUCKET` in `@pyric/cli/vite/internal/supplied-rows`); a test pins
 * the two to one value.
 */
export const UNREAD_BUCKET = 'bucket-not-read-from-the-sdk-reference';

function isObject(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function valueAt(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  const found = valueAt(value, keys);
  return typeof found === 'string' && found !== '' ? found : undefined;
}

/** The bucket a reference names, or the unread bucket. */
function bucketOf(ref: unknown): string {
  const bucket = stringAt(ref, ['bucket']);
  const isTaken = bucket !== undefined && BUCKET_NAME.test(bucket);
  return isTaken ? bucket : UNREAD_BUCKET;
}

const MAX_METADATA_SIZE = 32 * 1024;
const SETTABLE_STRING_FIELDS = [
  'cacheControl',
  'contentDisposition',
  'contentEncoding',
  'contentLanguage',
  'contentType',
] as const;

function copyCustomMetadata(value: unknown, budget: { left: number }): Record<string, string> | undefined {
  if (!isObject(value) || Array.isArray(value)) return undefined;
  const copy: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue;
    budget.left -= key.length + entry.length + 6;
    if (budget.left < 0) return undefined;
    copy[key] = entry;
  }
  return copy;
}

function copyUploadMetadata(raw: unknown): Record<string, unknown> {
  if (!isObject(raw) || Array.isArray(raw)) return {};
  const budget = { left: MAX_METADATA_SIZE };
  const out: Record<string, unknown> = {};
  for (const field of SETTABLE_STRING_FIELDS) {
    const val = raw[field];
    if (typeof val === 'string') {
      budget.left -= field.length + val.length + 6;
      if (budget.left < 0) return {};
      out[field] = val;
    } else if (val === null) {
      budget.left -= field.length + 8;
      if (budget.left < 0) return {};
      out[field] = null;
    }
  }
  if ('customMetadata' in raw) {
    if (raw.customMetadata === null) {
      out.customMetadata = null;
    } else {
      const copied = copyCustomMetadata(raw.customMetadata, budget);
      if (copied !== undefined) out.customMetadata = copied;
    }
  }
  return out;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

/** The bytes a base64 string's trailing `=` signs stand in for: none, one or two. */
function base64Padding(clean: string): number {
  if (clean.endsWith('==')) return 2;
  if (clean.endsWith('=')) return 1;
  return 0;
}

function base64DecodedSize(value: string): number {
  const clean = value.replace(/\s+/g, '');
  if (clean.length === 0) return 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - base64Padding(clean));
}

function dataUrlInfo(value: string): { size: number; contentType?: string } | undefined {
  const comma = value.indexOf(',');
  if (comma === -1) return undefined;
  const header = value.slice(0, comma);
  const body = value.slice(comma + 1);
  if (!header.startsWith('data:')) return undefined;
  const meta = header.slice(5);
  const parts = meta.split(';');
  const mime = parts[0]?.trim();
  const isBase64 = parts.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
  let size: number;
  if (isBase64) {
    size = base64DecodedSize(body);
  } else {
    try {
      size = utf8ByteLength(decodeURIComponent(body));
    } catch {
      size = utf8ByteLength(body);
    }
  }
  const info: { size: number; contentType?: string } = { size };
  if (mime) info.contentType = mime;
  return info;
}

function binaryInfo(data: unknown): { size?: number; defaultContentType: string } {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return {
      size: data.size,
      defaultContentType: data.type !== '' ? data.type : 'application/octet-stream',
    };
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return {
      size: data.byteLength,
      defaultContentType: 'application/octet-stream',
    };
  }
  return { defaultContentType: 'application/octet-stream' };
}

function storageWriteDataOf(name: string, args: readonly unknown[]): Record<string, unknown> | undefined {
  if (name === 'uploadBytes' || name === 'uploadBytesResumable') {
    const info = binaryInfo(args[1]);
    if (info.size === undefined) return undefined;
    const meta = copyUploadMetadata(args[2]);
    return {
      contentType: info.defaultContentType,
      ...meta,
      size: info.size,
    };
  }
  if (name === 'uploadString') {
    const raw = args[1];
    if (typeof raw !== 'string') return undefined;
    const format = typeof args[2] === 'string' ? args[2] : 'raw';
    const meta = copyUploadMetadata(args[3]);
    if (format === 'data_url') {
      const parsed = dataUrlInfo(raw);
      if (parsed === undefined) return undefined;
      return {
        contentType: parsed.contentType ?? 'application/octet-stream',
        ...meta,
        size: parsed.size,
      };
    }
    const size = format === 'base64' || format === 'base64url' ? base64DecodedSize(raw) : utf8ByteLength(raw);
    return {
      contentType: 'application/octet-stream',
      ...meta,
      size,
    };
  }
  if (name === 'updateMetadata') {
    return isObject(args[1]) && !Array.isArray(args[1]) ? copyUploadMetadata(args[1]) : undefined;
  }
  return undefined;
}

/**
 * The record context of one call, from its reference: the app (whose Auth
 * names the account), the project, the bucket, which is always named, and
 * the path, which a root reference leaves off, plus metadata-only `writeData`
 * for uploads and metadata updates.
 */
export function storageContext(name: string, args: readonly unknown[]): CallContext {
  try {
    const ref = args[0];
    const app = valueAt(ref, ['storage', 'app']);
    const projectId = stringAt(app, ['options', 'projectId']);
    const path = stringAt(ref, ['fullPath']);
    const context: CallContext = {
      ...(isObject(app) ? { subject: app } : {}),
      ...(projectId === undefined ? {} : { projectId }),
      bucket: bucketOf(ref),
      ...(path === undefined ? {} : { path }),
    };
    const writeData = storageWriteDataOf(name, args);
    if (writeData === undefined) return context;
    return { ...context, writeData };
  } catch {
    // A reference that throws on read is still recorded, without its context.
    return { bucket: UNREAD_BUCKET };
  }
}

/** Extracts bounded `FullMetadata` fields from a resolved `getMetadata` call. */
export function storageResult(site: ObservedSite, result: unknown): ResultReading {
  if (site.name !== 'getMetadata' || !isObject(result) || Array.isArray(result)) return {};
  const meta = copyUploadMetadata(result);
  const doc: Record<string, unknown> = { ...meta };
  if (typeof result.size === 'number' && Number.isFinite(result.size) && result.size >= 0) {
    doc.size = result.size;
  }
  for (const field of ['fullPath', 'bucket', 'timeCreated', 'updated', 'generation', 'metageneration'] as const) {
    const val = result[field];
    if (typeof val === 'string') doc[field] = val;
  }
  return Object.keys(doc).length > 0 ? { document: doc } : {};
}

/** A stream that hands the app the SDK's chunks, and a promise that settles when the SDK's stream ends or errors. */
interface FollowedStream {
  readonly readable: ReadableStream<unknown>;
  readonly ended: Promise<void>;
}

/**
 * Follows the SDK's stream: the app reads the SDK's own chunks through a new
 * stream, and `ended` resolves when the SDK's stream ends and rejects with
 * its error, production's denial included. A stream the app never reads to
 * the end ends nothing, and one the app cancels settles nothing, so only
 * production's answers are recorded.
 */
function followStream(sdk: ReadableStream<unknown>): FollowedStream {
  const reader = sdk.getReader();
  let end: () => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const ended = new Promise<void>((resolve, reject) => {
    end = resolve;
    fail = reject;
  });
  const readable = new ReadableStream<unknown>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        fail(error);
        controller.error(error);
        return;
      }
      if (!chunk.done) return controller.enqueue(chunk.value);
      end();
      controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { readable, ended };
}

function isStream(value: unknown): value is ReadableStream<unknown> {
  return typeof ReadableStream === 'function' && value instanceof ReadableStream;
}

/**
 * The row's `getStream` (Node only; the browser build throws, as it does
 * without live mode): the app gets a stream that follows the SDK's, and the
 * call is recorded once, ok when the SDK's stream ends, or its error's code.
 * A value that is not a stream comes back as the SDK returned it.
 */
export function observedGetStream(real: Callback, site: Site): Callback {
  let handed: unknown;
  const followed = observedCall({ ...site, name: 'getStream' }, function streamEnd(this: unknown, ...args: unknown[]): unknown {
    const returned = Reflect.apply(real, this, args);
    if (!isStream(returned)) {
      handed = returned;
      return returned;
    }
    const stream = followStream(returned);
    handed = stream.readable;
    return stream.ended;
  });
  return function getStream(this: unknown, ...args: unknown[]): unknown {
    handed = undefined;
    const ended = Reflect.apply(followed, this, args);
    // The app reads the stream's error from the stream; this promise only records it.
    if (ended instanceof Promise) Promise.prototype.then.call(ended, undefined, () => undefined);
    return handed;
  };
}
