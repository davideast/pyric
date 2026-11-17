import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deleteApp, initializeApp } from 'firebase/app';
import * as nodeStorageSdk from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails } from '../../src/storage-probe-session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

interface StorageModuleShape {
  getStorage: typeof nodeStorageSdk.getStorage;
  ref: typeof nodeStorageSdk.ref;
  getBlob: typeof nodeStorageSdk.getBlob;
}

interface RootCallObservation {
  rootFullPath: string;
  rootName: string;
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
  message: string | null;
  fetchCalls: number;
}

interface PackageExportsBrowserShape {
  exports?: {
    '.'?: {
      browser?: string | { import?: string };
    };
  };
  browser?: string;
  module?: string;
}

function resolveBrowserStorageModuleUrl(): string {
  const req = createRequire(import.meta.url);
  const wrapperMain = req.resolve('firebase/storage');
  const pkgJsonPath = req.resolve('@firebase/storage/package.json', { paths: [wrapperMain] });
  const pkgDir = dirname(pkgJsonPath);
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageExportsBrowserShape;
  const dotBrowser = manifest.exports?.['.']?.browser;
  let relEntry = '';
  if (typeof dotBrowser === 'string') {
    relEntry = dotBrowser;
  } else if (dotBrowser && typeof dotBrowser.import === 'string') {
    relEntry = dotBrowser.import;
  } else if (typeof manifest.browser === 'string') {
    relEntry = manifest.browser;
  } else if (typeof manifest.module === 'string') {
    relEntry = manifest.module;
  }
  if (!relEntry) {
    throw new Error('@firebase/storage/package.json declares no browser module entry');
  }
  return pathToFileURL(join(pkgDir, relEntry)).href;
}

async function observeRootGetBlobWithModule(
  sdk: StorageModuleShape,
  appLabel: string,
): Promise<RootCallObservation> {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error('unexpected network fetch during root-reference getBlob preflight');
    },
    { preconnect: originalFetch.preconnect },
  );

  const app = initializeApp(
    { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
    `client-storage-getblob-root-${appLabel}-${Date.now()}`,
  );

  try {
    const storage = sdk.getStorage(app);
    const rootRef = sdk.ref(storage);
    const rootFullPath = rootRef.fullPath;
    const rootName = rootRef.name;

    let threw = false;
    let threwSynchronously = false;
    let caughtError: unknown = null;

    try {
      const resultPromise = sdk.getBlob(rootRef);
      try {
        await resultPromise;
      } catch (asyncErr) {
        threw = true;
        caughtError = asyncErr;
      }
    } catch (syncErr) {
      threw = true;
      threwSynchronously = true;
      caughtError = syncErr;
    }

    const details = extractObservedErrorDetails(caughtError);
    return {
      rootFullPath,
      rootName,
      threw,
      threwSynchronously,
      ...details,
      fetchCalls,
    };
  } finally {
    globalThis.fetch = originalFetch;
    await deleteApp(app);
  }
}

/**
 * `@firebase/app` allows only one `'storage'` component registration per JS
 * realm, so importing `firebase/storage` in Node locks the realm to the Node
 * bundle (where `getBlob` throws an environment guard). Running the browser
 * bundle in a fresh child realm observes `@firebase/storage`'s real browser
 * `getBlob(ref(storage))` root-reference preflight without collision.
 */
function observeIsolatedBrowserBundleRootGetBlob(): RootCallObservation {
  const browserStorageUrl = resolveBrowserStorageModuleUrl();
  const inlineScript = [
    'const [appMod, storageMod] = await Promise.all([',
    '  import("firebase/app"),',
    '  import(process.env.PROBE_BROWSER_STORAGE_URL),',
    ']);',
    'let fetchCalls = 0;',
    'globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };',
    'const app = appMod.initializeApp({ projectId: "demo-storage-probe", storageBucket: "buckets-default" }, "browser-root-probe");',
    'try {',
    '  const storage = storageMod.getStorage(app);',
    '  const rootRef = storageMod.ref(storage);',
    '  let threw = false;',
    '  let threwSynchronously = false;',
    '  let caught = null;',
    '  try {',
    '    const pending = storageMod.getBlob(rootRef);',
    '    try { await pending; } catch (e) { threw = true; caught = e; }',
    '  } catch (e) {',
    '    threw = true;',
    '    threwSynchronously = true;',
    '    caught = e;',
    '  }',
    '  let code = null;',
    '  let errorName = null;',
    '  let message = null;',
    '  if (caught !== null && typeof caught === "object") {',
    '    if (typeof caught.code === "string") { code = caught.code; }',
    '    if (typeof caught.name === "string") { errorName = caught.name; }',
    '    if (typeof caught.message === "string") { message = caught.message; }',
    '  } else if (caught !== null && caught !== undefined) {',
    '    message = String(caught);',
    '  }',
    '  process.stdout.write(JSON.stringify({',
    '    rootFullPath: rootRef.fullPath,',
    '    rootName: rootRef.name,',
    '    threw,',
    '    threwSynchronously,',
    '    code,',
    '    errorName,',
    '    isFirebaseError: errorName === "FirebaseError",',
    '    message,',
    '    fetchCalls,',
    '  }));',
    '} finally {',
    '  await appMod.deleteApp(app);',
    '}',
  ].join('\n');

  const out = spawnSync(process.execPath, ['-e', inlineScript], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_BROWSER_STORAGE_URL: browserStorageUrl,
    },
  });
  if (out.status !== 0) {
    throw new Error(
      `Browser @firebase/storage root-ref probe child failed (${String(out.status)}): ${out.stderr || out.stdout}`,
    );
  }
  return JSON.parse(out.stdout) as RootCallObservation;
}

export const probe: Probe = {
  rig: 'client-storage',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage getBlob(ref(storage)) on the root reference: observes the browser bundle client-side root preflight (throws FirebaseError storage/invalid-root-operation with zero network requests) alongside the Node bundle environment guard.',
  async observe() {
    const browserRootRef = observeIsolatedBrowserBundleRootGetBlob();
    const nodeEntryRootRef = await observeRootGetBlobWithModule(nodeStorageSdk, 'node');
    return {
      browserRootRef,
      nodeEntryRootRef,
    };
  },
};
