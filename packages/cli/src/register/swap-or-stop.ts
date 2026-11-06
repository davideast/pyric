/**
 * Swap or stop (ADR 0022): under the register, `firebase` and `firebase-admin`
 * imports resolve to the sandbox. When a resolve lands in the real SDK anyway,
 * through an absolute path, an npm alias, a link under another name, or a
 * direct `@firebase/*` import, the import stops before the file loads. The
 * real SDK never runs, so it never reaches production with this machine's
 * credentials.
 *
 * The package is named by the resolved file's own `package.json`
 * (`package-identity.ts`), never by its folder. Only files under a
 * `node_modules` directory are checked: every installed SDK lives under one,
 * including the pnpm and bun stores, and the check stays off the resolve path
 * for everything else.
 *
 * The real SDK is allowed only where the swap table chooses it
 * (`choosesRealFirebase` in `mapping.ts`), or when an SDK file this hook
 * already allowed imports what its entry needs: a firebase-admin file
 * reaches only the verifier bridge pair's files, and a client SDK file only
 * the `@firebase/*` packages the production AI entries import. The importer's
 * URL alone is no proof, since `createRequire` can name any file, so each
 * hook keeps the URLs it allowed. In sandbox AI mode that set stays empty.
 * `firebase-admin` is never chosen, with one exception: the App Check verifier
 * bridge that production AI mode loads on pyric's behalf (#1552), whose
 * firebase-admin app holds no credentials. An app's own import of the real
 * package still stops. `PYRIC_GUARD` does not change any of this: the stop
 * belongs to the swap, not to the network guard.
 *
 * Loaded by both resolve hooks, including the loader-thread one, so it imports
 * node built-ins and side-effect-free modules only.
 */
import { fileURLToPath } from 'node:url';
import { packageNameOf, pathInPackageOf } from './package-identity.js';
import { choosesRealFirebase } from './mapping.js';
import { usesCommonJs } from '../functions/module-loader.js';
import {
  SDK_MODULES,
  isAdminBridgeFile,
  isBypassedBridgeImport,
  isProductionAiSdkPackage,
  resolveAiMode,
  type AiMode,
} from '../serve/firebase-module-swap.js';
import { INSTALLED_SDK_SPECIFIERS } from '../serve/vite-supplied-rows.js';
import { joinedList } from './word-list.js';

/** The code on the error a stopped import throws. */
export const REAL_SDK_STOPPED_CODE = 'PYRIC_REAL_SDK_STOPPED';

const LOG_PREFIX = '@pyric/cli/register';
/** The live register reports its stops under its own name. */
const LIVE_LOG_PREFIX = '@pyric/live/register';
const REPORT_URL = 'https://github.com/davideast/pyric/issues/new';

/** One resolve the register finished: what was asked, by whom, and where it landed. */
export interface ResolvedLoad {
  readonly specifier: string;
  /** The canonical name of a Turbopack-renamed specifier, when it is one. */
  readonly canonical?: string | null;
  readonly importer: string | undefined;
  readonly url: string;
  /** Defaults to the mode `PYRIC_AI_MODE` and `PYRIC_AI_PASSTHROUGH` select. */
  readonly aiMode?: AiMode;
  /** Defaults to the manifest lookup in `package-identity.ts`. */
  readonly nameOf?: (url: string) => string | null;
  /** Defaults to `pathInPackageOf` in `package-identity.ts`. */
  readonly pathInPackage?: (url: string, packageName: string) => string | null;
}

type SdkFamily = 'admin' | 'client';

/** `firebase-admin` is the admin SDK; `firebase` and every `@firebase/*` package are the client SDK. */
function sdkFamilyOf(name: string | null): SdkFamily | null {
  if (name === 'firebase-admin') return 'admin';
  const isClientPackage = name === 'firebase' || (name?.startsWith('@firebase/') ?? false);
  return isClientPackage ? 'client' : null;
}

/**
 * Whether a `package.json` `name` is a Firebase SDK this hook stops when the
 * swap does not choose it. `withPyric` keeps every such dependency external,
 * however the app names it, so Node resolves it here (#1626).
 */
export function isFirebaseSdkName(name: string | null): boolean {
  return sdkFamilyOf(name) !== null;
}

function isInstalledFile(url: string): boolean {
  return url.startsWith('file:') && url.includes('/node_modules/');
}

/**
 * Whether this load is an SDK file the hook already allowed, importing what
 * that SDK entry needs: a firebase-admin file reaches only the files of the
 * verifier bridge's `firebase-admin/app` and `firebase-admin/app-check`, and a
 * client SDK file only the `@firebase/*` packages that `firebase/ai`,
 * `firebase/app` and `firebase/app-check` import. So a `createRequire` forge
 * from an allowed file gets no further than the entry it came from.
 */
function isFromAllowedSdkFile(load: ResolvedLoad, packageName: string, allowedUrls: ReadonlySet<string>): boolean {
  const importer = load.importer;
  const isAllowedImporter = importer !== undefined && allowedUrls.has(importer);
  if (!isAllowedImporter) return false;
  const importerFamily = sdkFamilyOf((load.nameOf ?? packageNameOf)(importer));
  if (importerFamily === 'client') return isProductionAiSdkPackage(packageName);
  const isAdminTarget = importerFamily === 'admin' && packageName === 'firebase-admin';
  if (!isAdminTarget) return false;
  const pathOf = load.pathInPackage ?? pathInPackageOf;
  return isAdminBridgeFile(pathOf(load.url, packageName));
}

/** Whether this load may reach the real SDK. */
function isAllowedRealLoad(load: ResolvedLoad, packageName: string, family: SdkFamily, allowedUrls: ReadonlySet<string>): boolean {
  if (isFromAllowedSdkFile(load, packageName, allowedUrls)) return true;
  const specifier = load.canonical ?? load.specifier;
  const aiMode = load.aiMode ?? resolveAiMode(undefined, process.env);
  if (family === 'admin') return isBypassedBridgeImport(specifier, load.importer, aiMode);
  const pathOf = load.pathInPackage ?? pathInPackageOf;
  return choosesRealFirebase({
    specifier,
    importer: load.importer,
    packageName,
    pathInPackage: () => pathOf(load.url, packageName),
    aiMode,
  });
}

/** The served `firebase/*` import that stands for a `@firebase/*` package, when pyric serves one. */
function servedImportFor(packageName: string): string | null {
  const candidate = `firebase/${packageName.slice('@firebase/'.length)}`;
  const isServed = (SDK_MODULES as readonly string[]).includes(candidate);
  return isServed ? candidate : null;
}

/** The import an app writes in place of the one that stopped. */
function fixFor(family: SdkFamily, packageName: string): string {
  if (family === 'admin') {
    return "import firebase-admin by its package name (for example 'firebase-admin/app'), so the register routes it to the sandbox";
  }
  if (packageName === 'firebase') {
    return "import firebase by its package name (for example 'firebase/firestore'), so the register routes it to the sandbox";
  }
  const served = servedImportFor(packageName);
  if (served === null) {
    return `pyric serves no firebase/* import for '${packageName}', so import a served one (for example 'firebase/firestore'), or move this code out of the sandboxed process`;
  }
  return `import '${served}' instead of '${packageName}', so the register routes it to the sandbox`;
}

function stopMessage(load: ResolvedLoad, family: SdkFamily, packageName: string): string {
  const consequence = family === 'admin'
    ? "so it would have run with this machine's Google credentials"
    : "so it would have reached production with the app's API key";
  return [
    `${LOG_PREFIX}: stopped loading the real ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    `Under pyric, ${packageName} resolves to the sandbox. This import didn't, ${consequence}.`,
    `Fix: ${fixFor(family, packageName)}. To run the real SDK, start this process without @pyric/cli/register.`,
    `If pyric should have routed this import, report it: ${REPORT_URL}`,
    `code: ${REAL_SDK_STOPPED_CODE}`,
  ].join('\n');
}

/** The stop's message under live rows: only a row module's own import loads the installed SDK. */
function liveStopMessage(load: ResolvedLoad, family: SdkFamily, packageName: string): string {
  const isUnservedRequire = isNode22Require(load);
  const cause = isUnservedRequire
    ? `CommonJS require() on Node ${process.versions.node} can't be served under live mode, so this load skipped @pyric/live's rows and pyric would not see its calls.`
    : "In live mode, the installed SDK loads only through @pyric/live's rows. This import didn't, so pyric would not see its calls.";
  return [
    `${LIVE_LOG_PREFIX}: stopped loading the real ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    cause,
    `Fix: ${liveStopFix(family, isUnservedRequire)}. To run the real SDK unobserved, start this process without @pyric/live/register.`,
    `code: ${REAL_SDK_STOPPED_CODE}`,
  ].join('\n');
}

/**
 * Whether this load comes from a CommonJS file on Node 22. Node 22.15 runs
 * a CommonJS entry's `require()` outside the sync hooks and imports the file
 * it found, so live mode cannot serve it its row; Node 23 and later can.
 */
function isNode22Require(load: ResolvedLoad): boolean {
  const isNode22 = Number(process.versions.node.split('.')[0]) < 23;
  const importer = load.importer;
  const isFileImporter = importer !== undefined && importer.startsWith('file:');
  return isNode22 && isFileImporter && usesCommonJs(fileURLToPath(importer));
}

/** `firebase/app, firebase/auth, ... or firebase/database`: one import per live row. */
const LIVE_ROW_IMPORTS = joinedList([...INSTALLED_SDK_SPECIFIERS], 'or');

function liveStopFix(family: SdkFamily, isUnservedRequire: boolean): string {
  if (family === 'admin') {
    return "import firebase-admin by its package name, with pyricLive({ passThrough: ['firebase-admin'] }) on the live host, " +
      'or move this code to a process without @pyric/live/register';
  }
  if (isUnservedRequire) return `import ${LIVE_ROW_IMPORTS} from an ES module, or run Node 23 or later`;
  return `import ${LIVE_ROW_IMPORTS} by its package name, so its live row loads the installed SDK`;
}

/**
 * Whether this load is Node 22 resolving again a CommonJS file this hook
 * already allowed. Node 22 resolves a CommonJS file imported from ESM a second
 * time, by its own path and with no importer; Node 24 does not. That second
 * pass loads nothing new, so it goes ahead. An app's import of the same file
 * names its importer, so it still stops.
 */
function isCjsReloadOfAllowedFile(load: ResolvedLoad, allowedUrls: ReadonlySet<string>): boolean {
  const hasNoImporter = load.importer === undefined;
  const wasAllowed = allowedUrls.has(load.url);
  if (!hasNoImporter || !wasAllowed) return false;
  return load.specifier === fileURLToPath(load.url);
}

/**
 * The error that stops this load, or `null` when the load may go ahead: it is
 * not the real SDK, or the swap table chose the real SDK here. `allowedUrls`
 * is the calling hook's record of the real SDK files it allowed; an allowed
 * load joins it.
 */
export function stopFor(load: ResolvedLoad, allowedUrls: Set<string>): Error | null {
  if (!isInstalledFile(load.url)) return null;
  const packageName = (load.nameOf ?? packageNameOf)(load.url);
  const family = sdkFamilyOf(packageName);
  if (family === null || packageName === null) return null;
  if (isCjsReloadOfAllowedFile(load, allowedUrls)) return null;
  if (isAllowedRealLoad(load, packageName, family, allowedUrls)) {
    allowedUrls.add(load.url);
    return null;
  }
  const error = new Error(stopMessage(load, family, packageName));
  return Object.assign(error, { code: REAL_SDK_STOPPED_CODE, url: load.url, specifier: load.specifier });
}

/**
 * The client SDK packages the live rows' entries load, besides `firebase`
 * itself: what `firebase/app`, `firebase/auth`, `firebase/firestore`,
 * `firebase/app-check`, `firebase/database`, the AI row's `firebase/ai`, the
 * Storage row's `firebase/storage` and the Messaging rows' `firebase/messaging`
 * and `firebase/messaging/sw` import on Node 22 and 24.
 * `live-row-sdk-packages.test.ts` derives this set again from the installed
 * SDK, so an SDK that loads one more package fails that test rather than
 * stopping at run time. Only live rows read it: the
 * production AI mode stops (`stopFor`, #1635) keep their own list.
 */
export const LIVE_ROW_SDK_PACKAGES: ReadonlySet<string> = new Set([
  '@firebase/app',
  '@firebase/auth',
  '@firebase/firestore',
  '@firebase/app-check',
  '@firebase/database',
  '@firebase/ai',
  '@firebase/storage',
  '@firebase/messaging',
  '@firebase/installations',
  '@firebase/component',
  '@firebase/util',
  '@firebase/logger',
  '@firebase/webchannel-wrapper',
]);

/** How a load under live rows was asked for. */
export interface SuppliedRowsGrant {
  /** A row module's own import of its specifier. */
  readonly isRowImport: boolean;
  /** Resolved with the `import` condition: an ESM import, which `createRequire` cannot make. */
  readonly isEsmImport: boolean;
  /** The app's own import of a specifier the register passes through (`firebase/functions`). */
  readonly isPassThroughImport?: boolean;
  /**
   * The `@firebase/*` packages the passed-through entries load besides the
   * rows' (`passThroughSdkPackages` in `../serve/vite-supplied-rows.ts`).
   */
  readonly passThroughPackages?: ReadonlySet<string>;
  /**
   * The app's own `firebase-admin` import, which the register passes through
   * (`passThrough: ['firebase-admin']`): it may load the real Admin SDK.
   */
  readonly isAdminImport?: boolean;
  /**
   * An import made by a file of the Admin SDK's tree: every file a passed-through
   * `firebase-admin` import reached, directly or not (`supplied-entry.ts`). It
   * loads what the Admin SDK needs, `@google-cloud/firestore` and the
   * `@firebase/*` packages it uses among them.
   */
  readonly isFromAdminTree?: boolean;
}

/**
 * Whether `load` is the entry of the passed-through specifier it names: a
 * file of the `firebase` package under that specifier's own folder
 * (`firebase/functions` → `functions/dist/`), as the page plane checks it.
 */
function isPassThroughEntry(load: ResolvedLoad): boolean {
  const folder = `${load.specifier.slice('firebase/'.length)}/dist/`;
  return (load.pathInPackage ?? pathInPackageOf)(load.url, 'firebase')?.startsWith(folder) ?? false;
}

/**
 * Whether a load under live rows may reach the installed client SDK: an ESM
 * import, either a row module's own import of `firebase/*`, the app's import
 * of a passed-through entry, or an allowed client SDK file's import of a
 * package the live rows' entries or a passed-through one load. A
 * `createRequire` call can name any file as its importer, but it resolves
 * with the `require` condition, so it never passes.
 */
function isAllowedLiveRowLoad(load: ResolvedLoad, packageName: string, allowedUrls: ReadonlySet<string>, grant: SuppliedRowsGrant): boolean {
  if (!grant.isEsmImport) return false;
  if (grant.isRowImport) return packageName === 'firebase';
  if (grant.isPassThroughImport === true) return packageName === 'firebase' && isPassThroughEntry(load);
  const importer = load.importer;
  const isFromAllowedFile = importer !== undefined && allowedUrls.has(importer);
  const isLoadedPackage = LIVE_ROW_SDK_PACKAGES.has(packageName) || (grant.passThroughPackages?.has(packageName) ?? false);
  return isFromAllowedFile && isLoadedPackage;
}

/** Why a server SDK stops under live rows, and what the app imports instead. */
interface ServerSdkStop {
  /** What the SDK would reach that pyric neither observes nor can tell from what it lets through. */
  readonly reaches: string;
  readonly fix: string;
}

/**
 * The Google server SDKs that reach a host the network guard passes on their
 * own connection. `@google-cloud/firestore` speaks gRPC to
 * `firestore.googleapis.com`, as the live rows' Firestore does, so the guard
 * cannot tell its sockets from the rows' (`live-net-guard.ts`).
 * `@google-cloud/storage` reaches `storage.googleapis.com`, which the guard
 * passes for a passed-through `firebase-admin` and which a shared HTTP
 * library's frame could reach as the Admin SDK's. Other Google client
 * libraries reach hosts the guard refuses by host. A passed-through
 * `firebase-admin` still loads both, from its own tree.
 */
const LIVE_HOST_SERVER_SDKS: Readonly<Record<string, ServerSdkStop>> = {
  '@google-cloud/firestore': {
    reaches: "Cloud Firestore on its own gRPC connection, which pyric neither observes nor can tell from the rows'",
    fix: 'import firebase/firestore, which live mode serves to a Node process',
  },
  '@google-cloud/storage': {
    reaches: "Cloud Storage's JSON API, which pyric neither observes nor can tell from the Admin SDK's own calls",
    fix: "import firebase/storage, which live mode serves to a Node process, or firebase-admin/storage with pyricLive({ passThrough: ['firebase-admin'] })",
  },
};

function isLiveHostServerSdk(packageName: string | null): packageName is string {
  return packageName !== null && Object.hasOwn(LIVE_HOST_SERVER_SDKS, packageName);
}

/** The stop's message for a server SDK under live rows: it would reach production unobserved. */
function serverSdkStopMessage(load: ResolvedLoad, packageName: string): string {
  const stop = LIVE_HOST_SERVER_SDKS[packageName]!;
  return [
    `${LIVE_LOG_PREFIX}: stopped loading ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    "In live mode, only the installed Firebase SDK reaches production, through @pyric/live's rows, so pyric sees each call. " +
      `${packageName} would reach ${stop.reaches}.`,
    `Fix: ${stop.fix}, or move this code to a process without @pyric/live/register.`,
    `code: ${REAL_SDK_STOPPED_CODE}`,
  ].join('\n');
}

function serverSdkStop(load: ResolvedLoad, packageName: string): Error {
  const error = new Error(serverSdkStopMessage(load, packageName));
  return Object.assign(error, { code: REAL_SDK_STOPPED_CODE, url: load.url, specifier: load.specifier });
}

/**
 * The stop under live rows (`supplied-rows.ts`): the error that stops this
 * load, or `null` when it may go ahead. The client SDK loads only for a row
 * module's own ESM import of its specifier, and then for the packages those
 * files import ({@link isAllowedLiveRowLoad}); `firebase-admin` and the
 * server SDKs in {@link LIVE_HOST_SERVER_SDKS} load only when the register
 * passes `firebase-admin` through: the app's own import of it, then whatever
 * its tree imports ({@link SuppliedRowsGrant.isFromAdminTree}).
 * An allowed load joins `allowedUrls`. The swap table and AI mode play no
 * part: live rows replace the swap.
 */
export function suppliedRowsStopFor(load: ResolvedLoad, allowedUrls: Set<string>, grant: SuppliedRowsGrant): Error | null {
  if (!isInstalledFile(load.url)) return null;
  // The Admin SDK passes through as a whole: its tree loads what it needs, unobserved.
  if (grant.isFromAdminTree === true) return null;
  const packageName = (load.nameOf ?? packageNameOf)(load.url);
  const isAdminEntry = grant.isAdminImport === true && packageName === 'firebase-admin';
  if (isAdminEntry) return null;
  if (isLiveHostServerSdk(packageName)) return serverSdkStop(load, packageName);
  const family = sdkFamilyOf(packageName);
  if (family === null || packageName === null) return null;
  if (isCjsReloadOfAllowedFile(load, allowedUrls)) return null;
  if (family === 'client' && isAllowedLiveRowLoad(load, packageName, allowedUrls, grant)) {
    allowedUrls.add(load.url);
    return null;
  }
  const error = new Error(liveStopMessage(load, family, packageName));
  return Object.assign(error, { code: REAL_SDK_STOPPED_CODE, url: load.url, specifier: load.specifier });
}

/** Writes each stop to stderr once per file, so a caught import still shows in the log. */
export function createStopReporter(write: (line: string) => void): (error: Error) => void {
  const reported = new Set<string>();
  return (error) => {
    const url = (error as { url?: string }).url ?? error.message;
    if (reported.has(url)) return;
    reported.add(url);
    write(`${error.message}\n`);
  };
}
