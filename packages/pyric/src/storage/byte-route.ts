/**
 * The host's byte route, and the URL on it for an object a production download
 * URL names. The CLI's host, its remote client, and `pyric/storage/sw` share it.
 */
import { matchStorageUrl, type StorageLocation } from './url-forms.js';

/**
 * The Node host's HTTP byte route. Its paths follow Firebase's download paths
 * under the pyric namespace: `<prefix><bucket>/o/<encoded path>` for an object,
 * `<prefix><bucket>/o?name=…` for an upload.
 */
export const STORAGE_ROUTE_PREFIX = '/__pyric/storage/v0/b/';

/** An object's path on the byte route, with a token when the URL must carry its own authority. */
export function storageObjectPath(bucket: string, path: string, token?: string): string {
  const query = new URLSearchParams({ alt: 'media' });
  const hasToken = token !== undefined;
  if (hasToken) query.set('token', token);
  return `${STORAGE_ROUTE_PREFIX}${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?${query}`;
}

/** The hosts production serves Storage objects from. */
const PRODUCTION_STORAGE_HOSTS = new Set([
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'storage.cloud.google.com',
]);

/** Cloud Storage's JSON API paths, which share `storage.googleapis.com` but do not start with a bucket. */
const JSON_API_PATH = /^\/(?:download\/|upload\/)?storage\/v1\//;

/** The bucket and object a production URL names, or undefined when it names none. */
function productionLocationOf(url: URL): StorageLocation | undefined {
  const isProductionHost = PRODUCTION_STORAGE_HOSTS.has(url.hostname);
  if (!isProductionHost) return undefined;
  const isJsonApi = JSON_API_PATH.test(url.pathname);
  if (isJsonApi) return undefined;
  let location: StorageLocation | undefined;
  try {
    location = matchStorageUrl(url.href);
  } catch {
    return undefined;
  }
  if (location === undefined) return undefined;
  const namesAnObject = location.path !== '';
  if (!namesAnObject) return undefined;
  return location;
}

/**
 * The byte route URL, on the host at `hostOrigin`, for the object a production
 * download URL names.
 *
 * It takes the download URL form
 * (`https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=…`)
 * and the Cloud Storage forms (`https://storage.googleapis.com/<bucket>/<path>`,
 * `storage.cloud.google.com`), names the same bucket and object on the host's
 * byte route, and keeps the URL's `token`. A token set through
 * `firebaseStorageDownloadTokens` therefore grants the local URL as it granted
 * the production one. Other query parameters, such as `generation`, name
 * production state and are dropped. A Cloud Storage URL carries no token, so
 * the host grants its local URL only once a token is added to it.
 *
 * Returns undefined for a URL that names no object on those hosts.
 */
export function localStorageUrl(productionUrl: string, hostOrigin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(productionUrl);
  } catch {
    return undefined;
  }
  const location = productionLocationOf(url);
  if (location === undefined) return undefined;
  const token = url.searchParams.get('token') ?? undefined;
  return new URL(storageObjectPath(location.bucket, location.path, token), hostOrigin).href;
}
