/** Host-only seams for attaching Firebase-shaped apps to managed sandboxes. */
import type { FirebaseApp, FirebaseOptions } from './types.js';
import type { Sandbox } from '../sandbox/types/service.js';
import {
  attachSandboxApp,
  isSandboxAppDeleted,
  ownSandboxAppResource,
} from './runtime.js';

export { bindAppRegistrySandbox } from './registry.js';
export { firebaseOptionsEqual } from './options.js';
export { isSandboxAppDeleted };

/** Host-only lifecycle seam for resources owned by one FirebaseApp. */
export function registerAppCleanup(
  app: FirebaseApp,
  cleanup: () => void | Promise<void>,
): () => void {
  return ownSandboxAppResource(app, cleanup);
}

export function createAppForSandbox(
  sandbox: Sandbox,
  options: FirebaseOptions,
  name: string,
): FirebaseApp {
  const app = {
    name,
    options: structuredClone(options),
    automaticDataCollectionEnabled: true,
  } as FirebaseApp;
  attachSandboxApp(app, sandbox);
  return app;
}
