/**
 * `getStorage` and `getDownloadURL` entry points for `pyric-admin/storage`.
 */

import { isRemoteSandbox } from 'pyric/sandbox';
import {
  ADMIN_APP_TARGET,
  type PyricAdminApp,
} from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { getSandboxStorage } from './local-storage.js';
import { getRemoteStorage } from './remote-storage.js';
import type { File, Storage, StorageApp } from './types.js';
import { DOWNLOAD_URL, type DownloadUrlSource } from './upload-spool.js';

/**
 * Get the {@link Storage} service for the given app, or for the default app
 * when omitted.
 */
export function getStorage(app?: StorageApp): Storage {
  let resolved: unknown = app;
  if (resolved === undefined) {
    resolved = getDefaultServiceApp();
  }
  if (
    resolved === null ||
    typeof resolved !== 'object' ||
    !(ADMIN_APP_TARGET in resolved)
  ) {
    throw new TypeError(
      'pyric-admin/storage: getStorage expected a PyricAdminApp from `initializeApp`; ' +
        'received a value with no recognized ADMIN_APP_TARGET brand.',
    );
  }
  const adminApp = resolved as PyricAdminApp;
  assertAdminAppActive(adminApp);
  if (adminApp[ADMIN_APP_TARGET] === 'sandbox') {
    const configuredBucket = adminApp.options.storageBucket;
    if (isRemoteSandbox(adminApp.sandbox)) {
      return getRemoteStorage(adminApp, adminApp.sandbox, configuredBucket);
    }
    return getSandboxStorage(adminApp, configuredBucket);
  }
  throw new TypeError(
    'pyric-admin/storage: getStorage expected a PyricAdminApp from `initializeApp`; ' +
      'received a value with no recognized ADMIN_APP_TARGET brand.',
  );
}

/**
 * Mirror of `firebase-admin/storage`'s `getDownloadURL(file)`. A file without
 * a download token gets one in `firebaseStorageDownloadTokens`, as production
 * mints it. On the Node host the URL is its HTTP byte route URL; in process
 * and on a SharedWorker host the URL is a `data:` URI carrying the bytes.
 */
export async function getDownloadURL(file: File): Promise<string> {
  if (file === null || typeof file !== 'object') {
    throw new TypeError(
      'pyric-admin/storage: getDownloadURL expects a File from getStorage().bucket().file().',
    );
  }
  const source = file as File & Partial<DownloadUrlSource>;
  const downloadFn = source[DOWNLOAD_URL];
  if (typeof downloadFn !== 'function') {
    throw new TypeError(
      'pyric-admin/storage: getDownloadURL expects a File from getStorage().bucket().file().',
    );
  }
  return downloadFn.call(source);
}
