/**
 * The bundle the import map serves for `firebase/app`. Lets the canonical
 * idiom — `import { initializeApp } from 'firebase/app'` — run unmodified:
 * the Firebase config is accepted and ignored (there is no real backend to
 * configure; the page runs on the pyric sandbox), and the returned handle is
 * a `PyricApp` branded onto the page's ONE shared sandbox, so
 * `getAuth(app)` / `getFirestore(app)` dispatch to the same backend the bare
 * calls default to. Browser-bundled by `../bundler.ts`; never imported by
 * node-side code.
 */
import { initializeApp as pyricInitializeApp, type PyricApp } from 'pyric/app';
import { sandbox } from './runtime.js';

/** What app code passes — the real FirebaseOptions shape. Unused under
 *  serve; kept on the handle (`app.options`) for code that reads it. */
export type FirebaseOptions = Record<string, unknown>;

export type ServeFirebaseApp = PyricApp & {
  readonly name: string;
  readonly options: FirebaseOptions;
  automaticDataCollectionEnabled: boolean;
};

const DEFAULT_NAME = '[DEFAULT]';
const apps = new Map<string, ServeFirebaseApp>();
let configNoticeShown = false;

export function initializeApp(
  options: FirebaseOptions = {},
  rawName?: string | { name?: string },
): ServeFirebaseApp {
  const name = (typeof rawName === 'string' ? rawName : rawName?.name) ?? DEFAULT_NAME;
  // One page, one sandbox: re-init (even with different options) returns the
  // existing handle instead of firebase's app/duplicate-app — every "app" on
  // a served page is the same backend anyway.
  const existing = apps.get(name);
  if (existing) return existing;
  if (!configNoticeShown && Object.keys(options).length > 0) {
    configNoticeShown = true;
    console.info(
      '[pyric dev] initializeApp(): your Firebase config is unused on this page — firebase/* is served by the pyric sandbox.',
    );
  }
  const app = Object.assign(pyricInitializeApp({ sandbox }), {
    name,
    options,
    automaticDataCollectionEnabled: false,
  }) as ServeFirebaseApp;
  apps.set(name, app);
  return app;
}

export function getApp(name: string = DEFAULT_NAME): ServeFirebaseApp {
  const app = apps.get(name);
  if (!app) {
    // firebase/app parity: reading an app before initializeApp is an app
    // bug — surface it the way the real SDK would, not leniently.
    throw Object.assign(
      new Error(
        `No Firebase App '${name}' has been created - call initializeApp() first (app/no-app).`,
      ),
      { code: 'app/no-app', name: 'FirebaseError' },
    );
  }
  return app;
}

export function getApps(): ServeFirebaseApp[] {
  return [...apps.values()];
}

export async function deleteApp(app: ServeFirebaseApp): Promise<void> {
  apps.delete(app.name);
}
