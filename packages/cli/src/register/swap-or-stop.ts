/**
 * Swap or stop (ADR 0022, ADR 0023): under the register, `firebase` and
 * `firebase-admin` imports resolve to the sandbox. When a resolve lands in the
 * real SDK anyway -- through an absolute path, an npm alias, a vendored copy, a
 * link under another name (inside or outside `node_modules`, including under
 * `--preserve-symlinks`), an unserved `firebase/*` subpath, or a direct
 * `@firebase/*` import -- the import stops before the file loads. The real SDK
 * never runs, so it never reaches production with this machine's credentials.
 *
 * The package is named by the resolved file's own `package.json`
 * (`package-identity.ts`), never by its folder. Every `file:` URL is checked,
 * with manifest lookups cached once per directory in `package-identity.ts`, so
 * vendored copies and links outside `node_modules` are caught alongside
 * standard `node_modules`, pnpm, and bun installs (#1620).
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
 * package still stops.
 *
 * Runs inside synchronous module.registerHooks resolve callbacks, so it imports
 * node built-ins and side-effect-free modules only.
 */
import { fileURLToPath } from 'node:url';
import { canonicalFileUrl, isSameLocalFile, packageNameOf, pathInPackageOf } from './package-identity.js';
import { choosesRealFirebase } from './mapping.js';
import { usesCommonJs } from '../functions/module-loader.js';
import {
  SDK_MODULES,
  isAdminBridgeFile,
  isBypassedBridgeImport,
  isProductionAiSdkFile,
  isProductionAiSdkPackage,
  resolveAiMode,
  type AiMode,
} from '../serve/firebase-module-swap.js';
import { INSTALLED_SDK_SPECIFIERS } from '../serve/vite-supplied-rows.js';
import {
  findGoogleServerSdkStop,
  isStoppedServerSdkSpecifier,
  liveServerSdkStop,
  missingServerSdkSpecifierStop,
  sandboxServerSdkStop,
} from './server-sdk-stop.js';
import { joinedList } from './word-list.js';

/** The code on the error a stopped import throws. */
export const REAL_SDK_STOPPED_CODE = 'PYRIC_REAL_SDK_STOPPED';

const LOG_PREFIX = '@pyric/cli/register';
/** The live register reports its stops under its own name. */
const LIVE_LOG_PREFIX = '@pyric/live/register';
const REPORT_URL = 'https://github.com/davideast/pyric/issues/new';
const SERVED_FIREBASE_SPECIFIERS: ReadonlySet<string> = new Set(SDK_MODULES);

/** One resolve the register finished: what was asked, by whom, and where it landed. */
export interface ResolvedLoad {
  readonly specifier: string;
  /** The canonical name of a Turbopack-renamed specifier, when it is one. */
  readonly canonical?: string | null;
  readonly importer: string | undefined;
  readonly url: string;
  /** Defaults to the mode `PYRIC_AI_MODE` and `PYRIC_AI_PASSTHROUGH` select. */
  readonly aiMode?: AiMode;
  /** Whether the load resolved under the `import` condition; CJS `createRequire` calls pass `false`. */
  readonly isEsmImport?: boolean;
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
 * Whether a `package.json` `name` is a Firebase or stopped Google server SDK
 * that this hook refuses when the swap does not choose it. `withPyric` and
 * Vite SSR keep every such dependency external, however the app names it, so
 * Node resolves it here (#1626, #1609).
 */
export function isFirebaseSdkName(name: string | null): boolean {
  return sdkFamilyOf(name) !== null || findGoogleServerSdkStop(name) !== null;
}

function isFileUrl(url: string): boolean {
  return url.startsWith('file:');
}

/** Whether `specifier` is a `firebase/*` subpath that Pyric does not serve (#1623). */
export function isUnservedFirebaseSubpath(specifier: string): boolean {
  return specifier.startsWith('firebase/') && !SERVED_FIREBASE_SPECIFIERS.has(specifier);
}

/** Whether `specifier` is bare `firebase` or an unserved `firebase/*` subpath (#1623). */
export function isUnservedFirebaseImport(specifier: string): boolean {
  return specifier === 'firebase' || isUnservedFirebaseSubpath(specifier);
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
  const isAllowedImporter =
    importer !== undefined &&
    (allowedUrls.has(importer) || allowedUrls.has(canonicalFileUrl(importer)));
  if (!isAllowedImporter) return false;
  if (importer !== undefined && isSameLocalFile(importer, load.url)) return true;
  let nameResolver = packageNameOf;
  if (load.nameOf !== undefined) {
    nameResolver = load.nameOf;
  }
  const importerFamily = sdkFamilyOf(nameResolver(importer));
  let pathOf = pathInPackageOf;
  if (load.pathInPackage !== undefined) {
    pathOf = load.pathInPackage;
  }
  if (importerFamily === 'client') {
    if (isProductionAiSdkPackage(packageName)) return true;
    return isProductionAiSdkFile(packageName, () => pathOf(load.url, packageName));
  }
  const isAdminTarget = importerFamily === 'admin' && packageName === 'firebase-admin';
  if (!isAdminTarget) return false;
  return isAdminBridgeFile(pathOf(load.url, packageName));
}

/** Whether this load may reach the real SDK. */
function isAllowedRealLoad(load: ResolvedLoad, packageName: string, family: SdkFamily, allowedUrls: ReadonlySet<string>): boolean {
  if (isFromAllowedSdkFile(load, packageName, allowedUrls)) return true;
  const specifier = load.canonical ?? load.specifier;
  const aiMode = load.aiMode ?? resolveAiMode(undefined, process.env);
  if (family === 'admin') {
    return load.isEsmImport !== false && isBypassedBridgeImport(specifier, load.importer, aiMode);
  }
  const pathOf = load.pathInPackage ?? pathInPackageOf;
  return choosesRealFirebase({
    specifier,
    importer: load.importer,
    packageName,
    pathInPackage: () => pathOf(load.url, packageName),
    aiMode,
    isEsmImport: load.isEsmImport,
  });
}

/** The served `firebase/*` import that stands for a `@firebase/*` package (or subpath), when pyric serves one. */
function servedImportFor(packageName: string, specifier: string): string | null {
  if (specifier.startsWith(`${packageName}/`)) {
    const subpathCandidate = `firebase/${specifier.slice('@firebase/'.length)}`;
    if (SERVED_FIREBASE_SPECIFIERS.has(subpathCandidate)) {
      return subpathCandidate;
    }
  }
  const candidate = `firebase/${packageName.slice('@firebase/'.length)}`;
  return SERVED_FIREBASE_SPECIFIERS.has(candidate) ? candidate : null;
}

/** The import an app writes in place of the one that stopped. */
function fixFor(family: SdkFamily, packageName: string, specifier: string): string {
  if (family === 'admin') {
    return "import firebase-admin by its package name (for example 'firebase-admin/app'), so the register routes it to the sandbox";
  }
  if (isUnservedFirebaseSubpath(specifier)) {
    return `pyric serves no firebase/* import for '${specifier}', so import a served one (for example 'firebase/firestore'), or move this code out of the sandboxed process`;
  }
  if (packageName === 'firebase') {
    return "import firebase by its package name (for example 'firebase/firestore'), so the register routes it to the sandbox";
  }
  const served = servedImportFor(packageName, specifier);
  if (served === null) {
    return `pyric serves no firebase/* import for '${packageName}', so import a served one (for example 'firebase/firestore'), or move this code out of the sandboxed process`;
  }
  let replacedSpecifier = packageName;
  if (
    specifier.startsWith(`${packageName}/`) &&
    SERVED_FIREBASE_SPECIFIERS.has(`firebase/${specifier.slice('@firebase/'.length)}`)
  ) {
    replacedSpecifier = specifier;
  }
  return `import '${served}' instead of '${replacedSpecifier}', so the register routes it to the sandbox`;
}

function stopMessage(load: ResolvedLoad, family: SdkFamily, packageName: string): string {
  let consequence = "so it would have reached production with the app's API key";
  if (family === 'admin') {
    consequence = "so it would have run with this machine's Google credentials";
  }
  const canonicalSpecifier = load.canonical ?? load.specifier;
  return [
    `${LOG_PREFIX}: stopped loading the real ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    `Under pyric, ${packageName} resolves to the sandbox. This import didn't, ${consequence}.`,
    `Fix: ${fixFor(family, packageName, canonicalSpecifier)}. To run the real SDK, start this process without @pyric/cli/register.`,
    `If pyric should have routed this import, report it: ${REPORT_URL}`,
    `code: ${REAL_SDK_STOPPED_CODE}`,
  ].join('\n');
}

/**
 * The stop error for bare `firebase` or an unserved `firebase/*` subpath when
 * the `firebase` package is not installed in the caller's dependency tree or
 * does not export that entry, so every unserved Firebase import under the
 * register rejects with `PYRIC_REAL_SDK_STOPPED` (#1623).
 */
export function unservedFirebaseSubpathStop(
  specifier: string,
  importer: string | undefined,
  canonicalSpecifier: string = specifier,
): Error {
  const message = [
    `${LOG_PREFIX}: stopped unserved Firebase import '${specifier}'`,
    `  import '${specifier}'`,
    `  from   ${importer ?? 'the entry point'}`,
    `Under pyric, served firebase/* imports resolve to the sandbox, and '${specifier}' is not served.`,
    `Fix: ${fixFor('client', 'firebase', canonicalSpecifier)}. To run the real SDK, start this process without @pyric/cli/register.`,
    `If pyric should have routed this import, report it: ${REPORT_URL}`,
    `code: ${REAL_SDK_STOPPED_CODE}`,
  ].join('\n');
  const error = new Error(message);
  return Object.assign(error, { code: REAL_SDK_STOPPED_CODE, specifier });
}

/** The stop's message under live rows: only a row module's own import loads the installed SDK. */
function liveStopMessage(load: ResolvedLoad, family: SdkFamily, packageName: string, isRowImport: boolean): string {
  const isUnservedRequire = isNode22Require(load);
  let cause = "In live mode, the installed SDK loads only through @pyric/live's rows. This import didn't, so pyric would not see its calls.";
  if (isRowImport) {
    cause = `@pyric/live's ${load.specifier} row loads only ${load.specifier}'s own entry in firebase. ` +
      'This import resolved outside that entry, so its calls would skip the row and go unobserved.';
  } else if (isUnservedRequire) {
    cause = `CommonJS require() on Node ${process.versions.node} can't be served under live mode, so this load skipped @pyric/live's rows and pyric would not see its calls.`;
  }
  return [
    `${LIVE_LOG_PREFIX}: stopped loading the real ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    cause,
    `Fix: ${liveStopFix(family, isUnservedRequire, isRowImport, load.specifier)}. To run the real SDK unobserved, start this process without @pyric/live/register.`,
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

function liveStopFix(family: SdkFamily, isUnservedRequire: boolean, isRowImport: boolean, specifier: string): string {
  if (isRowImport) {
    return `remove any alias or redirect on '${specifier}', so its live row loads ${specifier}'s own entry in firebase`;
  }
  if (family === 'admin') {
    // Node 22's require() skips the hooks, so the Admin rows stay shut there and live mode refuses firebase-admin.
    const servesAdmin = Number(process.versions.node.split('.')[0]) >= 23;
    const where = servesAdmin ? 'by its package name, which live mode serves and observes' : 'from Node 23 or later, where live mode serves and observes it';
    return `import firebase-admin ${where}, or move this code to a process without @pyric/live/register`;
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
  if (!isFileUrl(load.url)) return null;
  const packageName = (load.nameOf ?? packageNameOf)(load.url);
  const serverStop = findGoogleServerSdkStop(packageName);
  if (serverStop !== null && packageName !== null) {
    return sandboxServerSdkStop(load, packageName, serverStop, REAL_SDK_STOPPED_CODE, LOG_PREFIX, REPORT_URL);
  }
  const family = sdkFamilyOf(packageName);
  if (family === null || packageName === null) return null;
  if (isCjsReloadOfAllowedFile(load, allowedUrls)) return null;
  if (isAllowedRealLoad(load, packageName, family, allowedUrls)) {
    allowedUrls.add(load.url);
    allowedUrls.add(canonicalFileUrl(load.url));
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
   * The app's own `firebase-admin` import, which the register serves through the Admin rows
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

const FIREBASE_SPECIFIER_PREFIX = 'firebase/';

/**
 * Whether `load` is the entry of the `firebase/*` specifier it names: a file
 * of the `firebase` package under that specifier's own folder
 * (`firebase/firestore` -> `firestore/dist/`, `firebase/messaging/sw` ->
 * `messaging/sw/dist/`), so an alias cannot redirect a live row or a
 * passed-through import to another entry (#2302).
 */
function isFirebaseSpecifierEntry(load: ResolvedLoad): boolean {
  if (!load.specifier.startsWith(FIREBASE_SPECIFIER_PREFIX)) return false;
  const subpath = load.specifier.slice(FIREBASE_SPECIFIER_PREFIX.length);
  if (subpath.length === 0) return false;
  const folder = `${subpath}/dist/`;
  const resolvePath = load.pathInPackage ?? pathInPackageOf;
  const relativePath = resolvePath(load.url, 'firebase');
  if (relativePath === null) return false;
  const escapesFolder = relativePath.startsWith('../') || relativePath.includes('/../');
  return !escapesFolder && relativePath.startsWith(folder);
}

/**
 * Whether a load under live rows may reach the installed client SDK: an ESM
 * import, either a row module's own import of `firebase/*`'s own entry, the
 * app's import of a passed-through entry, an ESM wrapper shim (`?iitm=true`)
 * re-importing the exact allowed file it wraps, or an allowed client SDK
 * file's import of a package the live rows' entries or a passed-through one
 * load. A `createRequire` call can name any file as its importer, but it
 * resolves with the `require` condition, so it never passes.
 */
function isAllowedLiveRowLoad(load: ResolvedLoad, packageName: string, allowedUrls: ReadonlySet<string>, grant: SuppliedRowsGrant): boolean {
  if (!grant.isEsmImport) return false;
  const isDirectSpecifierImport = grant.isRowImport || grant.isPassThroughImport === true;
  if (isDirectSpecifierImport) return packageName === 'firebase' && isFirebaseSpecifierEntry(load);
  const importer = load.importer;
  const isFromAllowedFile =
    importer !== undefined && (allowedUrls.has(importer) || allowedUrls.has(canonicalFileUrl(importer)));
  if (!isFromAllowedFile) return false;
  if (importer !== undefined && isSameLocalFile(importer, load.url)) return true;
  const isLoadedPackage = LIVE_ROW_SDK_PACKAGES.has(packageName) || (grant.passThroughPackages?.has(packageName) ?? false);
  return isLoadedPackage;
}

export { isStoppedServerSdkSpecifier };

/**
 * Stop error for a direct import of a stopped Google server SDK specifier when
 * the package or requested subpath is missing from `node_modules` (#1609).
 */
export function stoppedServerSdkSpecifierStop(
  specifier: string,
  importer: string | undefined,
): Error {
  return missingServerSdkSpecifierStop(specifier, importer, REAL_SDK_STOPPED_CODE, LOG_PREFIX, REPORT_URL);
}

/**
 * The stop under live rows (`supplied-rows.ts`): the error that stops this
 * load, or `null` when it may go ahead. The client SDK loads only for a row
 * module's own ESM import of its specifier, and then for the packages those
 * files import ({@link isAllowedLiveRowLoad}); `firebase-admin` and the
 * Google server SDKs in `server-sdk-stop.ts` load only when the register
 * passes `firebase-admin` through: the app's own import of it, then whatever
 * its tree imports ({@link SuppliedRowsGrant.isFromAdminTree}).
 * An allowed load joins `allowedUrls`. The swap table and AI mode play no
 * part: live rows replace the swap.
 */
export function suppliedRowsStopFor(load: ResolvedLoad, allowedUrls: Set<string>, grant: SuppliedRowsGrant): Error | null {
  if (!isFileUrl(load.url)) return null;
  // The Admin SDK passes through as a whole: its tree loads what it needs, unobserved.
  if (grant.isFromAdminTree === true) return null;
  const packageName = (load.nameOf ?? packageNameOf)(load.url);
  const isAdminEntry = grant.isAdminImport === true && packageName === 'firebase-admin';
  if (isAdminEntry) return null;
  const serverStop = findGoogleServerSdkStop(packageName);
  if (serverStop !== null && packageName !== null) {
    return liveServerSdkStop(load, packageName, serverStop, REAL_SDK_STOPPED_CODE, LIVE_LOG_PREFIX);
  }
  const family = sdkFamilyOf(packageName);
  if (family === null || packageName === null) return null;
  if (isCjsReloadOfAllowedFile(load, allowedUrls)) return null;
  if (family === 'client' && isAllowedLiveRowLoad(load, packageName, allowedUrls, grant)) {
    allowedUrls.add(load.url);
    allowedUrls.add(canonicalFileUrl(load.url));
    return null;
  }
  const error = new Error(liveStopMessage(load, family, packageName, grant.isRowImport));
  return Object.assign(error, { code: REAL_SDK_STOPPED_CODE, url: load.url, specifier: load.specifier });
}

/**
 * Whether a resolve hook's `conditions` names `import` (an ESM import rather
 * than CommonJS `require()`). Node 22 can pass `Set`, `Array`, other iterables,
 * non-iterable objects, or `undefined`.
 */
export function isImportCondition(conditions: unknown): boolean {
  if (Array.isArray(conditions)) return conditions.includes('import');
  if (conditions instanceof Set) return conditions.has('import');
  if (conditions !== null && typeof conditions === 'object' && Symbol.iterator in conditions) {
    for (const entry of conditions as Iterable<unknown>) {
      if (entry === 'import') return true;
    }
  }
  return false;
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
