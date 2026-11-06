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
import { observedCall, type CallContext, type ObservedSite } from './observe.js';

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
 * call still reaches Traffic.
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

/**
 * The record context of one call, from its reference: the app (whose Auth
 * names the account), the project, the bucket, which is always named, and
 * the path, which a root reference leaves off.
 */
export function storageContext(_name: string, args: readonly unknown[]): CallContext {
  try {
    const ref = args[0];
    const app = valueAt(ref, ['storage', 'app']);
    const projectId = stringAt(app, ['options', 'projectId']);
    const path = stringAt(ref, ['fullPath']);
    return {
      ...(isObject(app) ? { subject: app } : {}),
      ...(projectId === undefined ? {} : { projectId }),
      bucket: bucketOf(ref),
      ...(path === undefined ? {} : { path }),
    };
  } catch {
    // A reference that throws on read is still recorded, without its context.
    return { bucket: UNREAD_BUCKET };
  }
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
