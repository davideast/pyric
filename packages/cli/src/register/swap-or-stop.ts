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
 * (`choosesRealFirebase` in `mapping.ts`), or when one SDK file imports
 * another. `firebase-admin` is never chosen, with one exception: the App Check
 * verifier bridge that production AI mode loads on pyric's behalf (#1552),
 * whose firebase-admin app holds no credentials. An app's own import of the
 * real package still stops. `PYRIC_GUARD` does not change
 * any of this: the stop belongs to the swap, not to the network guard.
 *
 * Loaded by both resolve hooks, including the loader-thread one, so it imports
 * node built-ins and side-effect-free modules only.
 */
import { packageNameOf } from './package-identity.js';
import { choosesRealFirebase } from './mapping.js';
import { isBypassedBridgeImport, resolveAiMode, type AiMode } from '../serve/firebase-module-swap.js';

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

/** The package an importer belongs to, or `null` for the entry point or a non-file importer. */
function importerPackage(importer: string | undefined, nameOf: (url: string) => string | null): string | null {
  const isFileImporter = importer !== undefined && importer.startsWith('file:');
  return isFileImporter ? nameOf(importer) : null;
}

/** Whether this load may reach the real SDK. */
function isAllowedRealLoad(load: ResolvedLoad, packageName: string, family: SdkFamily): boolean {
  const nameOf = load.nameOf ?? packageNameOf;
  const fromInsideSdk = sdkFamilyOf(importerPackage(load.importer, nameOf)) !== null;
  if (fromInsideSdk) return true;
  const fromPyricBridge = isBypassedBridgeImport(load.canonical ?? load.specifier, load.importer);
  if (fromPyricBridge) return true;
  if (family === 'admin') return false;
  const aiMode = load.aiMode ?? resolveAiMode(undefined, process.env);
  return choosesRealFirebase({
    specifier: load.canonical ?? load.specifier,
    importer: load.importer,
    packageName,
    aiMode,
  });
}

/** The import an app writes in place of the one that stopped. */
function fixFor(family: SdkFamily, packageName: string): string {
  if (family === 'admin') {
    return "import firebase-admin by its package name (for example 'firebase-admin/app'), so the register routes it to the sandbox";
  }
  if (packageName === 'firebase') {
    return "import firebase by its package name (for example 'firebase/firestore'), so the register routes it to the sandbox";
  }
  const service = packageName.slice('@firebase/'.length);
  return `import 'firebase/${service}' instead of '${packageName}', so the register routes it to the sandbox`;
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
 * The error that stops this load, or `null` when the load may go ahead: it is
 * not the real SDK, or the swap table chose the real SDK here.
 */
export function stopFor(load: ResolvedLoad): Error | null {
  if (!isInstalledFile(load.url)) return null;
  const packageName = (load.nameOf ?? packageNameOf)(load.url);
  const family = sdkFamilyOf(packageName);
  if (family === null || packageName === null) return null;
  if (isAllowedRealLoad(load, packageName, family)) return null;
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
