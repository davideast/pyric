/**
 * The strings `ref()` reads as URLs, and the object each one names.
 *
 * `ref(storage, url)` accepts the URL forms production's `firebase/storage`
 * parses, with the same patterns:
 *
 * - `gs://<bucket>/<path>`, whose path is taken as written;
 * - `http(s)://firebasestorage.googleapis.com/v<n>/b/<bucket>/o/<path>`, the
 *   download URL form, whose path is percent-decoded and whose query is ignored;
 * - `http(s)://storage.googleapis.com/<bucket>/<path>` and
 *   `storage.cloud.google.com`, percent-decoded the same way.
 *
 * It also accepts the download URL the Node host issues,
 * `<origin>/__pyric/storage/v0/b/<bucket>/o/<path>`, on any origin. Production
 * never issues that form and throws `storage/invalid-url` for it.
 *
 * A `data:` URI is a download URL in process and on a SharedWorker host. It
 * carries an object's bytes, not its location, so `ref()` throws
 * `storage/invalid-url` for one. Production has no such URL and reads the
 * string as an object path.
 */
import { StorageError } from './errors.js';
import { matchStorageUrl, type StorageLocation } from './url-forms.js';

export type { StorageLocation } from './url-forms.js';

/** A `ref()` string is a URL when it starts with a scheme and `://`, as production decides. */
const SCHEME_URL = /^[A-Za-z]+:\/\//;

/** `data:[<media type>][;base64],<data>` */
const DATA_URI = /^data:[^,]*,/i;

function invalidUrl(url: string, detail: string): StorageError {
  return new StorageError('invalid-url', `Invalid URL '${url}'. ${detail}`);
}

/** Whether `ref()` reads `value` as a URL rather than as an object path. */
export function isStorageUrl(value: string): boolean {
  return SCHEME_URL.test(value) || DATA_URI.test(value);
}

/** The bucket and object path `url` names; throws `storage/invalid-url` when it names none. */
export function parseStorageUrl(url: string): StorageLocation {
  const isDataUri = DATA_URI.test(url);
  if (isDataUri) {
    throw invalidUrl(
      url.length > 64 ? `${url.slice(0, 64)}...` : url,
      'A data: URI carries an object\'s bytes, not its location. Reference the object by its path or its gs:// URL.',
    );
  }
  const location = matchStorageUrl(url);
  if (location !== undefined) return location;
  throw invalidUrl(url, 'Expected a gs:// URL or a Storage download URL.');
}

/**
 * The object path a `ref()` string argument names, before normalization.
 * `fromStorage` is whether `ref()` was given a Storage instance rather than a
 * reference: only a Storage instance takes a URL, as in production. The sandbox
 * serves one bucket, so a URL's bucket does not change which store the
 * reference reads.
 */
export function refPathOf(value: string | undefined, fromStorage: boolean): string {
  const given = value ?? '';
  const isUrl = isStorageUrl(given);
  if (!isUrl) return given;
  const isDataUri = DATA_URI.test(given);
  const urlOnReference = !fromStorage && !isDataUri;
  if (urlOnReference) {
    throw new StorageError('invalid-argument', 'To use ref(service, url), the first argument must be a Storage instance.');
  }
  return parseStorageUrl(given).path;
}
