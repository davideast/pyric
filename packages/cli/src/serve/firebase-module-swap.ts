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
 * cannot disagree about what production mode means. Dependency free, so the
 * Node register hook reads the same rule.
 */

/** Modules the swap serves. Keys are the bare specifiers app code uses. */
export const SDK_MODULES = [
  'firebase/ai',
  'firebase/app',
  'firebase/auth',
  'firebase/firestore',
  'firebase/database',
  'firebase/messaging',
  'firebase/messaging/sw',
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
  }
  return swapped;
}

/**
 * Whether an importer is a Pyric app module that wraps the Firebase SDK's own
 * `firebase/app`. Its `firebase/app` import must reach the SDK, never the swap.
 */
export function isShadowAppImporter(importer: string | undefined): boolean {
  if (importer === undefined) return false;
  return importer.includes('app-ai-passthrough') || importer.includes('app-bridge');
}
