/** Node register adapter for canonical `firebase/app` imports. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FirebaseApp, FirebaseAppSettings, FirebaseOptions } from 'firebase/app';
import { setRules } from 'pyric/sandbox/firestore';
import { initializeSandbox } from '../sandbox/index.js';
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

  const firebaseJsonPath = resolve(process.cwd(), 'firebase.json');
  if (!existsSync(firebaseJsonPath)) return;
  try {
    const config = JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as {
      firestore?: { rules?: unknown };
    };
    if (typeof config.firestore?.rules !== 'string') return;
    const rulesPath = resolve(process.cwd(), config.firestore.rules);
    if (!existsSync(rulesPath)) return;
    setRules(sandbox, readFileSync(rulesPath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `pyric/app/register: could not load firestore.rules: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function initializeApp(
  options?: FirebaseOptions,
  rawSettings?: string | FirebaseAppSettings,
): FirebaseApp {
  prepareNodeSandbox();
  return initializeRegistryApp(options, rawSettings);
}
