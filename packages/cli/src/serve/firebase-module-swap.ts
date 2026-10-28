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
 * the `pyric sandbox` import map (`html-injection.ts`) and the Vite resolver
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

function importerFile(importer: string): string {
  const withoutQuery = importer.replace(/[?#].*$/, '');
  const path = withoutQuery.startsWith('file://') ? fileURLToPath(withoutQuery) : withoutQuery;
  return path.replaceAll('\\', '/');
}

/**
 * Whether an importer is one of this package's own modules that wrap the
 * Firebase SDK's `firebase/app` or `firebase/app-check`. Those imports must
 * reach the SDK, never the swap. Anchored to this package, so an app file that
 * happens to be named `app-bridge.js` is still swapped.
 */
export function isShadowAppImporter(importer: string | undefined): boolean {
  if (importer === undefined) return false;
  const file = importerFile(importer);
  return PACKAGE_ROOTS.some((root) => file.startsWith(root) && SHADOW_MODULE.test(file.slice(root.length)));
}

/**
 * The SDK modules a shadow-app wrapper imports for itself. The firebase-admin
 * pair is the register's App Check verifier for production AI mode
 * (`register/app-bridge-admin-app-check.ts`); no browser plane serves them.
 */
const BRIDGED_SPECIFIERS: ReadonlySet<string> = new Set([
  'firebase/app',
  'firebase/app-check',
  'firebase-admin/app',
  'firebase-admin/app-check',
]);

/** Whether this import is a shadow-app wrapper reaching the Firebase SDK it wraps. */
export function isBypassedBridgeImport(specifier: string, importer: string | undefined): boolean {
  return BRIDGED_SPECIFIERS.has(specifier) && isShadowAppImporter(importer);
}
