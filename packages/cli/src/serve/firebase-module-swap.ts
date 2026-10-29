/**
 * The AI mode and the Firebase module swap it selects.
 *
 * `sandbox` answers `firebase/ai` from Pyric's broker. `production` leaves
 * `firebase/ai` to the Firebase SDK, which then calls Google AI or Vertex AI
 * with the app's own `initializeApp` config, and serves `firebase/app` through
 * the passthrough app so the SDK's `getAI(app)` finds a real component
 * container.
 *
 * Every plane that swaps Firebase modules reads {@link swappedFirebaseEntries}:
 * the `pyric sandbox` import map (`html-injection.ts`, through
 * {@link importMapFirebaseEntries}) and the Vite resolver
 * (`vite-module-swap.ts`). Every front door resolves the mode with
 * {@link resolveAiMode}. One table and one precedence rule, so the planes
 * cannot disagree about what production mode means. It imports only Node
 * built-ins, so the Node register hook reads the same rule.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Modules the swap serves. Keys are the bare specifiers app code uses. */
export const SDK_MODULES = [
  'firebase/ai',
  'firebase/analytics',
  'firebase/app',
  'firebase/app-check',
  'firebase/auth',
  'firebase/firestore',
  'firebase/firestore/lite',
  'firebase/functions',
  'firebase/database',
  'firebase/messaging',
  'firebase/messaging/sw',
  'firebase/performance',
  'firebase/remote-config',
  'firebase/storage',
] as const;

export type AiMode = 'sandbox' | 'production';

/** The served Firebase specifiers, `firebase/ai`, `firebase/messaging/sw`, .... */
export type ServedFirebaseSpecifier = (typeof SDK_MODULES)[number];

/**
 * The AI mode for an explicit option and an environment. An explicit option
 * wins; otherwise `PYRIC_AI_MODE=production` or `PYRIC_AI_PASSTHROUGH=1`
 * select production, and anything else is sandbox.
 */
export function resolveAiMode(
  explicit: AiMode | undefined,
  env: Record<string, string | undefined>,
): AiMode {
  if (explicit !== undefined) return explicit;
  const isProductionEnv = env.PYRIC_AI_MODE === 'production' || env.PYRIC_AI_PASSTHROUGH === '1';
  return isProductionEnv ? 'production' : 'sandbox';
}

/** The entry key a served specifier swaps to by default: the subpath with `/` as `-`. */
function defaultEntryKey(specifier: ServedFirebaseSpecifier): string {
  return specifier.slice('firebase/'.length).replaceAll('/', '-');
}

/**
 * Served Firebase specifier to Pyric entry key (`defaultSdkEntries()` key and
 * `/__pyric/sdk/<key>.js` bundle name) for one AI mode. A specifier absent
 * from the result is not swapped and resolves to the Firebase SDK.
 */
export function swappedFirebaseEntries(mode: AiMode): ReadonlyMap<ServedFirebaseSpecifier, string> {
  const swapped = new Map<ServedFirebaseSpecifier, string>();
  for (const specifier of SDK_MODULES) {
    swapped.set(specifier, defaultEntryKey(specifier));
  }
  if (mode === 'production') {
    swapped.delete('firebase/ai');
    swapped.set('firebase/app', 'app-ai-passthrough');
    // The Firebase App Check SDK, attached to the same shadow app as firebase/ai.
    swapped.set('firebase/app-check', 'app-ai-passthrough-app-check');
  }
  return swapped;
}

/**
 * The Firebase SDK modules `pyric sandbox` builds for the browser from the
 * project's own `firebase` install in production AI mode, to the entry key of
 * each (`/__pyric/sdk/<key>.js`). One build, so the three share one
 * `@firebase/app` component registry. The Vite and register planes resolve
 * the Firebase SDK themselves and never read this.
 */
export const REAL_SDK_ENTRIES: ReadonlyMap<ServedFirebaseSpecifier, string> = new Map([
  ['firebase/app', 'firebase-sdk-app'],
  ['firebase/ai', 'firebase-sdk-ai'],
  ['firebase/app-check', 'firebase-sdk-app-check'],
]);

/**
 * The `@firebase/*` packages the real AI SDK and the passthrough's
 * `firebase/app` and `firebase/app-check` import, which a server runner can
 * reach by file URL (Vite's module runner does).
 */
const PRODUCTION_AI_SDK_PACKAGES: ReadonlySet<string> = new Set([
  '@firebase/ai',
  '@firebase/app',
  '@firebase/app-check',
  '@firebase/app-check-interop-types',
  '@firebase/component',
  '@firebase/logger',
  '@firebase/util',
]);

/** The `firebase` package's own folders for the {@link REAL_SDK_ENTRIES}: `ai`, `app` and `app-check`. */
const PRODUCTION_AI_FIREBASE_FOLDERS: ReadonlySet<string> = new Set(
  [...REAL_SDK_ENTRIES.keys()].map((specifier) => specifier.slice('firebase/'.length)),
);

/**
 * Whether production AI mode lets a file of the real Firebase SDK load, from
 * any importer: a `firebase` file under `ai/`, `app/` or `app-check/` (the
 * {@link REAL_SDK_ENTRIES}), or a file of the `@firebase/*` packages those
 * import. Every other file of the client SDK is swapped or stopped, as in
 * sandbox mode. `pathInPackage` is the file's path inside its package, read
 * only for `firebase`.
 */
export function isProductionAiSdkFile(packageName: string, pathInPackage: () => string | null): boolean {
  if (PRODUCTION_AI_SDK_PACKAGES.has(packageName)) return true;
  if (packageName !== 'firebase') return false;
  const folder = pathInPackage()?.split('/')[0];
  return folder !== undefined && PRODUCTION_AI_FIREBASE_FOLDERS.has(folder);
}

/**
 * The import-map plane's specifier to entry key table: the swap, plus, in
 * production AI mode, the unswapped `firebase/ai` sent to the Firebase SDK
 * that `pyric sandbox` builds. A browser has no package resolution, so on
 * this plane an unswapped specifier still needs a URL.
 */
export function importMapFirebaseEntries(mode: AiMode): ReadonlyMap<ServedFirebaseSpecifier, string> {
  const entries = new Map(swappedFirebaseEntries(mode));
  for (const [specifier, key] of REAL_SDK_ENTRIES) {
    const isUnswapped = !entries.has(specifier);
    if (isUnswapped) entries.set(specifier, key);
  }
  return entries;
}

/** This package's root (`src/serve/` and `dist/serve/` both sit two levels below it), as written and resolved. */
const PACKAGE_ROOTS: readonly string[] = (() => {
  const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
  try {
    const real = `${realpathSync(root).replaceAll('\\', '/').replace(/\/$/, '')}/`;
    return real === root ? [root] : [root, real];
  } catch {
    return [root];
  }
})();

/** The shadow-app wrappers, relative to the package root. */
const SHADOW_MODULE = /^(?:dist|src)\/(?:register\/(?:client\/)?app-bridge[^/]*|serve\/entries\/app-ai-passthrough[^/]*)$/;

/** The register's App Check verifier for production AI mode, relative to the package root. */
const ADMIN_BRIDGE_MODULE = /^(?:dist|src)\/register\/app-bridge-admin-app-check\.(?:js|ts)$/;

function importerFile(importer: string): string {
  const withoutQuery = importer.replace(/[?#].*$/, '');
  const path = withoutQuery.startsWith('file://') ? fileURLToPath(withoutQuery) : withoutQuery;
  return path.replaceAll('\\', '/');
}

/** Whether an importer is one of this package's own modules whose path, relative to the package root, matches `module`. */
function isPackageModule(importer: string | undefined, module: RegExp): boolean {
  if (importer === undefined) return false;
  const file = importerFile(importer);
  return PACKAGE_ROOTS.some((root) => file.startsWith(root) && module.test(file.slice(root.length)));
}

/**
 * Whether an importer is one of this package's own modules that wrap the
 * Firebase SDK's `firebase/app` or `firebase/app-check`. Those imports must
 * reach the SDK, never the swap. Anchored to this package, so an app file that
 * happens to be named `app-bridge.js` is still swapped.
 */
export function isShadowAppImporter(importer: string | undefined): boolean {
  return isPackageModule(importer, SHADOW_MODULE);
}

/** The client SDK modules every shadow-app wrapper imports for itself. */
const BRIDGED_SPECIFIERS: ReadonlySet<string> = new Set(['firebase/app', 'firebase/app-check']);

/**
 * The firebase-admin pair that only the register's App Check verifier imports
 * (`register/app-bridge-admin-app-check.ts`), and only in production AI mode,
 * where the register loads it. No browser plane serves them.
 */
const ADMIN_BRIDGED_SPECIFIERS: ReadonlySet<string> = new Set(['firebase-admin/app', 'firebase-admin/app-check']);

/**
 * Whether this import is a shadow-app wrapper reaching the Firebase SDK it
 * wraps. The firebase-admin pair counts only when `aiMode` is `production`,
 * so a plane that passes no mode never bypasses it.
 */
export function isBypassedBridgeImport(specifier: string, importer: string | undefined, aiMode?: AiMode): boolean {
  if (BRIDGED_SPECIFIERS.has(specifier)) return isShadowAppImporter(importer);
  const isAdminBridgeImport = ADMIN_BRIDGED_SPECIFIERS.has(specifier) && aiMode === 'production';
  return isAdminBridgeImport && isPackageModule(importer, ADMIN_BRIDGE_MODULE);
}

/**
 * Where a bypassed bridge import goes on the import-map plane: the entry key
 * of the Firebase SDK module `pyric sandbox` builds. The bare specifier
 * cannot stay, because the import map sends it back to the wrapper itself.
 * Undefined for every import {@link isBypassedBridgeImport} does not name.
 */
export function bridgeImportEntryKey(specifier: string, importer: string | undefined): string | undefined {
  if (!isBypassedBridgeImport(specifier, importer)) return undefined;
  return REAL_SDK_ENTRIES.get(specifier as ServedFirebaseSpecifier);
}
