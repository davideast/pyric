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

/** The bucket and object path a Storage URL names. */
export interface StorageLocation {
  readonly bucket: string;
  readonly path: string;
}

const BUCKET = '([A-Za-z0-9.\\-_]+)';

/** A `ref()` string is a URL when it starts with a scheme and `://`, as production decides. */
const SCHEME_URL = /^[A-Za-z]+:\/\//;

/** `data:[<media type>][;base64],<data>` */
const DATA_URI = /^data:[^,]*,/i;

/** A URL form: its pattern captures the bucket, then the path. */
interface UrlForm {
  readonly pattern: RegExp;
  /** Turns the captured path into the object path. */
  readonly path: (captured: string) => string;
}

const asWritten = (value: string): string => value;

const URL_FORMS: readonly UrlForm[] = [
  { pattern: new RegExp(`^gs://${BUCKET}(?:/(.*))?$`, 'i'), path: asWritten },
  {
    pattern: new RegExp(`^https?://firebasestorage\\.googleapis\\.com/v[A-Za-z0-9_]+/b/${BUCKET}/o(?:/([^?#]*).*)?$`, 'i'),
    path: decodeURIComponent,
  },
  {
    pattern: new RegExp(`^https?://(?:storage\\.googleapis\\.com|storage\\.cloud\\.google\\.com)/${BUCKET}/([^?#]*)`, 'i'),
    path: decodeURIComponent,
  },
  {
    pattern: new RegExp(`^https?://[^/?#]+/__pyric/storage/v0/b/${BUCKET}/o/([^?#]+)`),
    path: decodeURIComponent,
  },
];

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
  for (const form of URL_FORMS) {
    const captured = form.pattern.exec(url);
    if (captured === null) continue;
    return { bucket: captured[1]!, path: form.path(captured[2] ?? '') };
  }
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
