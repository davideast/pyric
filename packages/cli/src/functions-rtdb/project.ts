import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FirebaseJson } from '../cli/firebase-json.js';

export interface FunctionsRtdbProject {
  sourceDir: string;
  entry: string;
}

interface FunctionsConfig {
  source?: unknown;
  codebase?: unknown;
}

/** Discover the one Node Functions source supported by the first RTDB slice. */
export function discoverFunctionsRtdbProject(cwd: string): FunctionsRtdbProject | null {
  const firebaseJsonPath = join(cwd, 'firebase.json');
  if (!existsSync(firebaseJsonPath)) return null;

  let config: FirebaseJson;
  try {
    config = JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as FirebaseJson;
  } catch (error) {
    throw new Error(
      `pyric dev: failed to parse firebase.json while discovering Functions: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (config.functions === undefined || config.functions === null) return null;

  const declared = Array.isArray(config.functions)
    ? config.functions as FunctionsConfig[]
    : [config.functions as FunctionsConfig];
  if (declared.length !== 1) {
    throw new Error(
      'pyric dev: multiple Functions codebases are not supported by the first ' +
        'onValueCreated slice; configure one source for this development session.',
    );
  }
  const functions = declared[0];
  if (typeof functions !== 'object' || functions === null) {
    throw new Error('pyric dev: firebase.json `functions` must be an object with a source.');
  }
  if (functions.source !== undefined && typeof functions.source !== 'string') {
    throw new Error('pyric dev: firebase.json `functions.source` must be a string.');
  }

  const sourceDir = resolve(cwd, functions.source ?? 'functions');
  const packageJsonPath = join(sourceDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `pyric dev: Functions source is declared but ${packageJsonPath} does not exist.`,
    );
  }

  let packageJson: { main?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { main?: unknown };
  } catch (error) {
    throw new Error(
      `pyric dev: failed to parse ${packageJsonPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (packageJson.main !== undefined && typeof packageJson.main !== 'string') {
    throw new Error(`pyric dev: ${packageJsonPath} \`main\` must be a string.`);
  }

  const entry = resolve(sourceDir, packageJson.main ?? 'index.js');
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`pyric dev: Functions entry does not exist: ${entry}`);
  }
  return { sourceDir, entry };
}
