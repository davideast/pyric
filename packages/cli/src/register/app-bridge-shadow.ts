/**
 * Production AI pass-through for canonical `firebase/app` in a registered Node
 * process: each Pyric app gets a shadow real Firebase app whose container the
 * real `firebase/ai` reads. Shared by the in-process adapter
 * (`./app-bridge.ts`) and the Node host client (`./client/app-bridge.ts`).
 */
import * as realApp from 'firebase/app';
import type { FirebaseApp, FirebaseAppSettings, FirebaseOptions } from 'pyric/app';

export interface PyricAppRegistry {
  initializeApp(options?: FirebaseOptions, rawSettings?: string | FirebaseAppSettings): FirebaseApp;
  getApp(name?: string): FirebaseApp;
  getApps(): FirebaseApp[];
  deleteApp(app: FirebaseApp): Promise<void>;
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
    const hasShadowContainer = shadow.container !== undefined && shadow.container !== null;
    if (hasShadowContainer) {
      Object.defineProperty(app, 'container', { value: shadow.container, configurable: true });
    }
  } catch {
    // Observational/best-effort: do not break Pyric initialization if shadow initialization fails.
  }
  return app;
}

/**
 * The shadow Firebase app for a Pyric app, by name. A Firebase app passed in
 * directly, or a Pyric app with no shadow yet, is returned unchanged.
 */
export function shadowAppOf(app: { name: string }): object {
  try {
    return realApp.getApp(app.name);
  } catch {
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
