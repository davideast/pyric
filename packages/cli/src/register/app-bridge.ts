/** Node register adapter for canonical `firebase/app` imports when production AI pass-through is active. */
import * as pyricApp from 'pyric/app/register';
import * as realApp from 'firebase/app';

function decorateApp(
  app: pyricApp.FirebaseApp,
  options?: pyricApp.FirebaseOptions,
  rawSettings?: string | pyricApp.FirebaseAppSettings,
): pyricApp.FirebaseApp {
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

export function initializeApp(
  options?: pyricApp.FirebaseOptions,
  rawSettings?: string | pyricApp.FirebaseAppSettings,
): pyricApp.FirebaseApp {
  const app = pyricApp.initializeApp(options, rawSettings);
  return decorateApp(app, options, rawSettings);
}

export function getApp(name?: string): pyricApp.FirebaseApp {
  return decorateApp(pyricApp.getApp(name));
}

export function getApps(): pyricApp.FirebaseApp[] {
  return pyricApp.getApps().map((app) => decorateApp(app));
}

export async function deleteApp(app: pyricApp.FirebaseApp): Promise<void> {
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
}

export {
  FirebaseError,
  SDK_VERSION,
  onLog,
  registerVersion,
  setLogLevel,
} from 'pyric/app/register';
export type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  LogCallback,
  LogEntry,
  LogLevel,
  LogOptions,
} from 'pyric/app/register';
