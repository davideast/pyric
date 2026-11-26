/**
 * Swap-or-Stop policy for Google server SDKs whose direct imports bypass Pyric
 * in both sandbox mode (#1609) and live mode:
 *
 * - `@google-cloud/firestore` speaks gRPC to `firestore.googleapis.com`
 * - `@google-cloud/storage` reaches `storage.googleapis.com` directly
 *
 * In sandbox mode neither package is ever allowed (even in production AI mode).
 * In live mode, a passed-through `firebase-admin` tree may still load both
 * through the Admin rows, while direct app imports stop with
 * `PYRIC_REAL_SDK_STOPPED`.
 *
 * Runs inside synchronous `module.registerHooks` resolve callbacks, so this
 * module stays side-effect-free with zero runtime imports.
 */

interface ServerSdkStop {
  readonly sandboxReaches: string;
  readonly sandboxFix: string;
  readonly liveReaches: string;
  readonly liveFix: string;
}

interface ServerSdkStopTarget {
  readonly specifier: string;
  readonly importer: string | undefined;
  readonly url: string;
}

const STOPPED_GOOGLE_SERVER_SDKS: Readonly<Record<string, ServerSdkStop>> = {
  '@google-cloud/firestore': {
    sandboxReaches: 'Cloud Firestore on its own gRPC connection',
    sandboxFix: "import 'firebase-admin/firestore' or 'firebase/firestore', so the register routes it to the sandbox",
    liveReaches: "Cloud Firestore on its own gRPC connection, which pyric neither observes nor can tell from the rows'",
    liveFix: 'import firebase/firestore, which live mode serves to a Node process',
  },
  '@google-cloud/storage': {
    sandboxReaches: "Cloud Storage's JSON API",
    sandboxFix: "import 'firebase-admin/storage' or 'firebase/storage', so the register routes it to the sandbox",
    liveReaches: "Cloud Storage's JSON API, which pyric neither observes nor can tell from the Admin SDK's own calls",
    liveFix: 'import firebase/storage, which live mode serves to a Node process, or firebase-admin/storage, which it observes',
  },
};

const STOPPED_GOOGLE_SERVER_SDK_NAMES: readonly string[] = Object.keys(STOPPED_GOOGLE_SERVER_SDKS);

/** Lookup stop metadata for a resolved package name, or `null` if not a stopped Google server SDK. */
export function findGoogleServerSdkStop(packageName: string | null): ServerSdkStop | null {
  if (packageName === null || !Object.hasOwn(STOPPED_GOOGLE_SERVER_SDKS, packageName)) {
    return null;
  }
  return STOPPED_GOOGLE_SERVER_SDKS[packageName] ?? null;
}

function stoppedServerSdkNameForSpecifier(specifier: string): string | null {
  for (const name of STOPPED_GOOGLE_SERVER_SDK_NAMES) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return name;
    }
  }
  return null;
}

/** Whether `specifier` directly names a stopped Google server SDK package or subpath (#1609). */
export function isStoppedServerSdkSpecifier(specifier: string): boolean {
  return stoppedServerSdkNameForSpecifier(specifier) !== null;
}

/** Stop error for a resolved Google server SDK file in sandbox mode (#1609). */
export function sandboxServerSdkStop(
  load: ServerSdkStopTarget,
  packageName: string,
  stop: ServerSdkStop,
  code: string,
  logPrefix: string,
  reportUrl: string,
): Error {
  const message = [
    `${logPrefix}: stopped loading the real ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    `Under pyric, ${packageName} would reach ${stop.sandboxReaches} with this machine's Google credentials instead of the sandbox.`,
    `Fix: ${stop.sandboxFix}. To run the real SDK, start this process without @pyric/cli/register.`,
    `If pyric should have routed this import, report it: ${reportUrl}`,
    `code: ${code}`,
  ].join('\n');
  const error = new Error(message);
  return Object.assign(error, { code, url: load.url, specifier: load.specifier });
}

/**
 * Stop error for a direct import of a stopped Google server SDK specifier when
 * the package or requested subpath is missing from `node_modules` (#1609).
 */
export function missingServerSdkSpecifierStop(
  specifier: string,
  importer: string | undefined,
  code: string,
  logPrefix: string,
  reportUrl: string,
): Error {
  const packageName = stoppedServerSdkNameForSpecifier(specifier) ?? specifier;
  const stop = findGoogleServerSdkStop(packageName);
  let reaches = 'Google Cloud directly';
  let fix = "import a served 'firebase-admin/*' or 'firebase/*' module";
  if (stop !== null) {
    reaches = stop.sandboxReaches;
    fix = stop.sandboxFix;
  }
  const message = [
    `${logPrefix}: stopped loading the real ${packageName}`,
    `  import '${specifier}'`,
    `  from   ${importer ?? 'the entry point'}`,
    `Under pyric, ${packageName} would reach ${reaches} with this machine's Google credentials instead of the sandbox.`,
    `Fix: ${fix}. To run the real SDK, start this process without @pyric/cli/register.`,
    `If pyric should have routed this import, report it: ${reportUrl}`,
    `code: ${code}`,
  ].join('\n');
  const error = new Error(message);
  return Object.assign(error, { code, specifier });
}

/** Stop error for a direct Google server SDK import under live rows. */
export function liveServerSdkStop(
  load: ServerSdkStopTarget,
  packageName: string,
  stop: ServerSdkStop,
  code: string,
  logPrefix: string,
): Error {
  const message = [
    `${logPrefix}: stopped loading ${packageName}`,
    `  import '${load.specifier}'`,
    `  from   ${load.importer ?? 'the entry point'}`,
    `  found  ${load.url}`,
    "In live mode, only the installed Firebase SDK reaches production, through @pyric/live's rows, so pyric sees each call. " +
      `${packageName} would reach ${stop.liveReaches}.`,
    `Fix: ${stop.liveFix}, or move this code to a process without @pyric/live/register.`,
    `code: ${code}`,
  ].join('\n');
  const error = new Error(message);
  return Object.assign(error, { code, url: load.url, specifier: load.specifier });
}
