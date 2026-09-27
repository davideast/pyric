/**
 * The content fields production fills in for Firebase Storage clients.
 *
 * A client upload through the Firebase Storage endpoint that sets no
 * `contentDisposition` stores `inline; filename*=utf-8''<file>`, where
 * `<file>` is the object path's last segment percent-encoded per RFC 5987. A
 * write through the GCS JSON API, which the admin plane stands for, stores no
 * `contentDisposition`.
 *
 * No write stores a default `contentEncoding`. The Firebase Storage endpoint
 * reports `identity` for an object that stores none, both to a client metadata
 * read and on `request.resource` for an upload or a metadata update. The GCS
 * JSON API reports it unset.
 */

/** Which API a caller reaches: the Firebase Storage client endpoint or the GCS JSON API. */
export type StoragePlane = 'client' | 'admin';

/** The plane a Storage handle reaches: its admin flag marks the admin plane. */
export function planeOf(target: { readonly admin?: boolean }): StoragePlane {
  return target.admin === true ? 'admin' : 'client';
}

/** `contentEncoding` the Firebase Storage endpoint reports for an object that stores none. */
export const CLIENT_DEFAULT_CONTENT_ENCODING = 'identity';

/**
 * The `contentDisposition` a client upload stores: the one it sets, or the
 * inline default named for the object's last path segment.
 */
export function uploadContentDisposition(set: string | undefined, objectPath: string): string {
  return set ?? `inline; filename*=utf-8''${rfc5987(objectPath.split('/').pop() ?? '')}`;
}

/** The `contentEncoding` a Firebase Storage client sees for an object storing `stored`. */
export function clientContentEncoding(stored: string | undefined): string {
  return stored ?? CLIENT_DEFAULT_CONTENT_ENCODING;
}

/** RFC 5987 `attr-char`: the characters an extended parameter value carries unencoded. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function rfc5987(value: string): string {
  let out = '';
  for (const char of value) {
    if (ATTR_CHAR.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}
