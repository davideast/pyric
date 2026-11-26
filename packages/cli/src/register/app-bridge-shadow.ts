/**
 * Production AI pass-through for canonical `firebase/app` in a registered Node
 * process: each Pyric app gets a shadow real Firebase app whose container the
 * real `firebase/ai` reads. Shared by the in-process adapter
 * (`./app-bridge.ts`), the Node host client (`./client/app-bridge.ts`), and
 * the served `firebase/app` entry (`serve/entries/app-ai-passthrough.ts`).
 */
import * as realApp from 'firebase/app';
import type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  FirebaseServerApp,
  FirebaseServerAppSettings,
} from 'pyric/app';

export interface PyricAppRegistry {
  initializeApp(options?: FirebaseOptions, rawSettings?: string | FirebaseAppSettings): FirebaseApp;
  initializeServerApp?(
    options?: FirebaseOptions | FirebaseApp | FirebaseServerAppSettings,
    rawSettings?: FirebaseServerAppSettings,
  ): FirebaseServerApp;
  getApp(name?: string): FirebaseApp;
  getApps(): FirebaseApp[];
  deleteApp(app: FirebaseApp): Promise<void>;
}

export interface ShadowedAppRegistry {
  initializeApp(options?: FirebaseOptions, rawSettings?: string | FirebaseAppSettings): FirebaseApp;
  initializeServerApp(
    options: FirebaseOptions | FirebaseApp | undefined,
    config?: FirebaseServerAppSettings,
  ): FirebaseServerApp;
  initializeServerApp(config?: FirebaseServerAppSettings): FirebaseServerApp;
  getApp(name?: string): FirebaseApp;
  getApps(): FirebaseApp[];
  deleteApp(app: FirebaseApp): Promise<void>;
}

const shadowServerApps = new WeakMap<object, realApp.FirebaseServerApp>();

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

function installFailedContainerGetter(app: FirebaseApp): void {
  Object.defineProperty(app, 'container', {
    configurable: true,
    enumerable: false,
    get() {
      const resolved = shadowAppOf(app);
      if (resolved === app) return undefined;
      return (resolved as { container?: unknown }).container;
    },
  });
}

function clearOwnContainer(app: FirebaseApp): void {
  const descriptor = Object.getOwnPropertyDescriptor(app, 'container');
  const isConfigurable = descriptor !== undefined && descriptor.configurable === true;
  if (isConfigurable) {
    delete (app as { container?: unknown }).container;
  }
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
    } else {
      clearOwnContainer(app);
    }
  } catch (error) {
    // Pyric's initializeApp still succeeds; both shadowAppOf (App Check) and
    // the non-enumerable `container` getter (unswapped firebase/ai `getAI(app)`)
    // report this cause if the service attaches without a shadow app (#1548).
    shadowFailures.set(app.name, error);
    installFailedContainerGetter(app);
  }
  return app;
}

function decorateServerApp(app: FirebaseServerApp): FirebaseServerApp {
  try {
    const initOptions = app.options as realApp.FirebaseOptions;
    const initSettings: realApp.FirebaseServerAppSettings = { ...app.settings };
    const shadow = realApp.initializeServerApp(initOptions, initSettings) as realApp.FirebaseServerApp & {
      container?: unknown;
    };
    shadowServerApps.set(app, shadow);
    shadowFailures.delete(app.name);
    const hasShadowContainer = shadow.container !== undefined && shadow.container !== null;
    if (hasShadowContainer) {
      Object.defineProperty(app, 'container', { value: shadow.container, configurable: true });
    } else {
      clearOwnContainer(app);
    }
  } catch (error) {
    shadowFailures.set(app.name, error);
    installFailedContainerGetter(app);
  }
  return app;
}

/**
 * The shadow Firebase app for a Pyric app, by name. When creating it failed,
 * throws an error that names the app and keeps the failure as `cause`. When a
 * real Firebase app of that name exists, clears any stale failure record so a
 * later deletion does not resurrect it. A Firebase app passed in directly, or
 * a Pyric app with no attempt yet, is returned unchanged.
 */
export function shadowAppOf(app: { name: string }): object {
  const shadowServer = shadowServerApps.get(app);
  if (shadowServer !== undefined) {
    shadowFailures.delete(app.name);
    return shadowServer;
  }
  try {
    const shadow = realApp.getApp(app.name);
    shadowFailures.delete(app.name);
    return shadow;
  } catch (err) {
    void err;
    const hasFailure = shadowFailures.has(app.name);
    if (hasFailure) throw shadowFailedError(app.name, shadowFailures.get(app.name));
    return app;
  }
}

export function shadowedAppRegistry(pyricApp: PyricAppRegistry): ShadowedAppRegistry {
  function initializeServerApp(
    options: FirebaseOptions | FirebaseApp | undefined,
    config?: FirebaseServerAppSettings,
  ): FirebaseServerApp;
  function initializeServerApp(config?: FirebaseServerAppSettings): FirebaseServerApp;
  function initializeServerApp(
    optionsOrConfig?: FirebaseOptions | FirebaseApp | FirebaseServerAppSettings,
    rawSettings?: FirebaseServerAppSettings,
  ): FirebaseServerApp {
    if (!pyricApp.initializeServerApp) {
      throw new Error('pyric: initializeServerApp is not supported on this app registry');
    }
    const app = pyricApp.initializeServerApp(optionsOrConfig, rawSettings);
    return decorateServerApp(app);
  }

  return {
    initializeApp(options, rawSettings) {
      const app = pyricApp.initializeApp(options, rawSettings);
      return decorateApp(app, options, rawSettings);
    },
    initializeServerApp,
    getApp(name) {
      return decorateApp(pyricApp.getApp(name));
    },
    getApps() {
      return pyricApp.getApps().map((app) => decorateApp(app));
    },
    async deleteApp(app) {
      const shadowServer = shadowServerApps.get(app);
      if (shadowServer !== undefined) {
        await pyricApp.deleteApp(app);
        try {
          await realApp.deleteApp(shadowServer);
        } catch (err) {
          void err;
        }
        let stillAlive = false;
        try {
          stillAlive = typeof app.name === 'string';
        } catch (err) {
          void err;
          stillAlive = false;
        }
        if (!stillAlive) {
          shadowServerApps.delete(app);
          clearOwnContainer(app);
        }
        return;
      }
      shadowFailures.delete(app.name);
      clearOwnContainer(app);
      try {
        const shadow = realApp.getApp(app.name);
        const hasShadow = shadow !== undefined && shadow !== null;
        if (hasShadow) {
          await realApp.deleteApp(shadow);
        }
      } catch (err) {
        // Ignore if shadow app was not initialized or already deleted.
        void err;
      }
      return pyricApp.deleteApp(app);
    },
  };
}
