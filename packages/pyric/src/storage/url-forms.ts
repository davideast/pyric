/**
 * The URL forms that name a Storage object, and the location each names. Free
 * of the SDK's errors and sandbox, so a service worker can load it.
 */

/** The bucket and object path a Storage URL names. */
export interface StorageLocation {
  readonly bucket: string;
  readonly path: string;
}

const BUCKET = '([A-Za-z0-9.\\-_]+)';

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

/** The bucket and object path `url` names in one of the URL forms, or undefined. */
export function matchStorageUrl(url: string): StorageLocation | undefined {
  for (const form of URL_FORMS) {
    const captured = form.pattern.exec(url);
    if (captured === null) continue;
    return { bucket: captured[1]!, path: form.path(captured[2] ?? '') };
  }
  return undefined;
}
