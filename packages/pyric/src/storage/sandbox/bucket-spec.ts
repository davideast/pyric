/**
 * Bucket specification parser matching `@firebase/storage`'s
 * `Location.makeFromBucketSpec(bucketString, host)`.
 *
 * Accepts `gs://<bucket>[/]`, root Firebase Storage download URLs
 * (`http(s)://firebasestorage.googleapis.com/v<n>/b/<bucket>/o[/]`), and bare
 * bucket names. Throws `StorageError('invalid-default-bucket')` synchronously
 * when `bucketString` parses as a Storage URL with a non-empty object path.
 * Non-URL strings (such as bare bucket names, `""`, or
 * `"https://storage.googleapis.com/<bucket>"` without a trailing slash) are
 * returned verbatim.
 */
import { StorageError } from '../errors.js';

const BUCKET_DOMAIN = '([A-Za-z0-9.\\-_]+)';
const GS_BUCKET_URL = new RegExp(`^gs://${BUCKET_DOMAIN}(?:/(.*))?$`, 'i');
const FIREBASE_STORAGE_URL = new RegExp(
  `^https?://firebasestorage\\.googleapis\\.com/v[A-Za-z0-9_]+/b/${BUCKET_DOMAIN}/o(?:/([^?#]*).*)?$`,
  'i',
);
const CLOUD_STORAGE_URL = new RegExp(
  `^https?://(?:storage\\.googleapis\\.com|storage\\.cloud\\.google\\.com)/${BUCKET_DOMAIN}/([^?#]*)`,
  'i',
);

interface ParsedBucketUrl {
  readonly bucket: string;
  readonly path: string;
}

function matchUpstreamStorageUrl(url: string): ParsedBucketUrl | undefined {
  try {
    const gsMatch = GS_BUCKET_URL.exec(url);
    if (gsMatch !== null && gsMatch[1] !== undefined) {
      let path = gsMatch[2] ?? '';
      if (path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      return { bucket: gsMatch[1], path };
    }

    const fbMatch = FIREBASE_STORAGE_URL.exec(url);
    if (fbMatch !== null && fbMatch[1] !== undefined) {
      const rawPath = fbMatch[2] ?? '';
      const path = decodeURIComponent(rawPath);
      return { bucket: fbMatch[1], path };
    }

    const cloudMatch = CLOUD_STORAGE_URL.exec(url);
    if (cloudMatch !== null && cloudMatch[1] !== undefined) {
      const rawPath = cloudMatch[2] ?? '';
      const path = decodeURIComponent(rawPath);
      return { bucket: cloudMatch[1], path };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Parse a `getStorage(app, bucketUrl)` or `app.options.storageBucket` string
 * into its bucket name, throwing `storage/invalid-default-bucket` when the
 * URL carries a non-empty object path.
 */
export function parseBucketSpec(bucketString: string): string {
  const matched = matchUpstreamStorageUrl(bucketString);
  if (matched === undefined) {
    return bucketString;
  }
  if (matched.path !== '') {
    throw new StorageError('invalid-default-bucket', `Invalid default bucket "${bucketString}".`);
  }
  return matched.bucket;
}
