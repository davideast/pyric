/** Node register adapter for canonical `firebase/app` imports. */
import type { FirebaseApp, FirebaseAppSettings, FirebaseOptions } from './types.js';
import { initializeSandbox } from '../sandbox/index.js';
import { loadProjectRules } from './register-rules.js';
import {
  bindAppRegistrySandbox,
  initializeApp as initializeRegistryApp,
} from './registry.js';

export * from './index.js';

let prepared = false;

function prepareNodeSandbox(): void {
  if (prepared) return;
  prepared = true;
  const sandbox = initializeSandbox();
  bindAppRegistrySandbox(sandbox);
  loadProjectRules(sandbox, process.cwd());
}

export function initializeApp(
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  prepareNodeSandbox();
  return initializeRegistryApp(options, rawSettings);
}
