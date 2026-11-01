/**
 * Production AI pass-through for canonical `firebase/app` in a registered Node
 * process: each Pyric app gets a shadow real Firebase app whose container the
 * real `firebase/ai` reads. Shared by the in-process adapter
 * (`./app-bridge.ts`), the Node host client (`./client/app-bridge.ts`), and
 * the served `firebase/app` entry (`serve/entries/app-ai-passthrough.ts`).
 */
import * as realApp from 'firebase/app';
import type { FirebaseApp, FirebaseAppSettings, FirebaseOptions } from 'pyric/app';

export interface PyricAppRegistry {
  initializeApp(options?: FirebaseOptions, rawSettings?: string | FirebaseAppSettings): FirebaseApp;
  getApp(name?: string): FirebaseApp;
  getApps(): FirebaseApp[];
  deleteApp(app: FirebaseApp): Promise<void>;
}

/**
 * Why the shadow app for a name could not be created, kept until a later
 * attempt succeeds or the app is deleted. It sits behind `Symbol.for` so every
 * bundle or module record of this file on a page or in a process shares it.
 */
const SHADOW_FAILURES = Symbol.for('pyric.ai.shadowAppFailures');
type GlobalShadowFailures = { [SHADOW_FAILURES]?: Map<string, unknown> };
const shadowFailures = ((globalThis as GlobalShadowFailures)[SHADOW_FAILURES] ??= new Map<string, unknown>());

function causeText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\.$/, '');
}

function shadowFailedError(name: string, cause: unknown): Error {
  return new Error(
    `Pyric could not create the Firebase app that firebase/app-check and firebase/ai attach to in production AI mode, for app "${name}": ${causeText(cause)}.`,
    { cause },
  );
}

function decorateApp(
  app: FirebaseApp,
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  try {
    let shadow: { container?: unknown };
    try {
      shadow = realApp.getApp(app.name) as { container?: unknown };
    } catch {
      const initOptions = (options ?? app.options) as realApp.FirebaseOptions;
      const initSettings = rawSettings ?? app.name;
      const isStringSettings = typeof initSettings === 'string';
      if (isStringSettings) {
        shadow = realApp.initializeApp(initOptions, initSettings) as { container?: unknown };
      } else {
        const objectSettings = initSettings as realApp.FirebaseAppSettings;
        shadow = realApp.initializeApp(initOptions, objectSettings) as { container?: unknown };
      }
    }
    shadowFailures.delete(app.name);
    const hasShadowContainer = shadow.container !== undefined && shadow.container !== null;
    if (hasShadowContainer) {
      Object.defineProperty(app, 'container', { value: shadow.container, configurable: true });
    }
  } catch (error) {
    // Pyric's initializeApp still succeeds; shadowAppOf reports the cause
    // when firebase/app-check or firebase/ai needs the shadow.
    shadowFailures.set(app.name, error);
  }
  return app;
}

/**
 * The shadow Firebase app for a Pyric app, by name. When creating it failed,
 * throws an error that names the app and keeps the failure as `cause`. A
 * Firebase app passed in directly, or a Pyric app with no attempt yet, is
 * returned unchanged.
 */
export function shadowAppOf(app: { name: string }): object {
  try {
    return realApp.getApp(app.name);
  } catch {
    const hasFailure = shadowFailures.has(app.name);
    if (hasFailure) throw shadowFailedError(app.name, shadowFailures.get(app.name));
    return app;
  }
}

export function shadowedAppRegistry(pyricApp: PyricAppRegistry): PyricAppRegistry {
  return {
    initializeApp(options, rawSettings) {
      const app = pyricApp.initializeApp(options, rawSettings);
      return decorateApp(app, options, rawSettings);
    },
    getApp(name) {
      return decorateApp(pyricApp.getApp(name));
    },
    getApps() {
      return pyricApp.getApps().map((app) => decorateApp(app));
    },
    async deleteApp(app) {
      shadowFailures.delete(app.name);
      try {
        const shadow = realApp.getApp(app.name);
        const hasShadow = shadow !== undefined && shadow !== null;
        if (hasShadow) {
          await realApp.deleteApp(shadow);
        }
      } catch {
        // Ignore if shadow app was not initialized or already deleted.
      }
      return pyricApp.deleteApp(app);
    },
  };
}
