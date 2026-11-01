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
import {
  SDK_MODULES,
  isAdminBridgeFile,
  isBypassedBridgeImport,
  isProductionAiSdkPackage,
  resolveAiMode,
  type AiMode,
} from '../serve/firebase-module-swap.js';

/** The code on the error a stopped import throws. */
export const REAL_SDK_STOPPED_CODE = 'PYRIC_REAL_SDK_STOPPED';

const LOG_PREFIX = '@pyric/cli/register';
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
