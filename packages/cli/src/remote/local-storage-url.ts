/**
 * The host's URL for an object an app server holds a production download URL for.
 */
import { parseStorageUrl, type StorageLocation } from 'pyric/storage/internal';
import { storageObjectPath } from '../serve/worker/protocol.js';

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
  let location: StorageLocation;
  try {
    location = parseStorageUrl(url.href);
  } catch {
    return undefined;
  }
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
