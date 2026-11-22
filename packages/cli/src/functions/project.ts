import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FirebaseJson } from '../cli/firebase-json.js';

export interface FunctionsProject {
  sourceDir: string;
  entry: string;
}

export interface DiscoverFunctionsProjectOptions {
  warn?: (message: string) => void;
}

interface FunctionsConfig {
  source?: unknown;
  codebase?: unknown;
}

const warnedMissingEntries = new Set<string>();

function defaultMissingEntryWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isExistingEntryFile(entryPath: string): boolean {
  if (!existsSync(entryPath)) return false;
  try {
    return statSync(entryPath).isFile();
  } catch {
    // Treat unreadable or transiently absent paths as missing build artifacts.
    return false;
  }
}

/** Discover the one Node Functions source supported by the sandbox runtime. */
export function discoverFunctionsProject(
  cwd: string,
  options: DiscoverFunctionsProjectOptions = {},
): FunctionsProject | null {
  const firebaseJsonPath = join(cwd, 'firebase.json');
  if (!existsSync(firebaseJsonPath)) return null;

  let config: FirebaseJson;
  try {
    config = JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as FirebaseJson;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `pyric sandbox: failed to parse firebase.json while discovering Functions: ${detail}`,
    );
  }
  if (config.functions === undefined || config.functions === null) return null;

  let declared: FunctionsConfig[];
  if (Array.isArray(config.functions)) {
    declared = config.functions as FunctionsConfig[];
  } else {
    declared = [config.functions as FunctionsConfig];
  }
  if (declared.length !== 1) {
    throw new Error(
      'pyric sandbox: multiple Functions codebases are not supported by the first ' +
        'onValueCreated slice; configure one source for this development session.',
    );
  }
  const functions = declared[0];
  if (typeof functions !== 'object' || functions === null) {
    throw new Error('pyric sandbox: firebase.json `functions` must be an object with a source.');
  }
  if (functions.source !== undefined && typeof functions.source !== 'string') {
    throw new Error('pyric sandbox: firebase.json `functions.source` must be a string.');
  }

  const configuredSource = functions.source ?? 'functions';
  const sourceDir = resolve(cwd, configuredSource);
  const packageJsonPath = join(sourceDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `pyric sandbox: Functions source is declared but ${packageJsonPath} does not exist.`,
    );
  }

  let packageJson: { main?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { main?: unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`pyric sandbox: failed to parse ${packageJsonPath}: ${detail}`);
  }
  if (packageJson.main !== undefined && typeof packageJson.main !== 'string') {
    throw new Error(`pyric sandbox: ${packageJsonPath} \`main\` must be a string.`);
  }

  const configuredMain = packageJson.main ?? 'index.js';
  const entry = resolve(sourceDir, configuredMain);
  const warningKey = `${sourceDir}\0${entry}`;
  if (!isExistingEntryFile(entry)) {
    if (!warnedMissingEntries.has(warningKey)) {
      warnedMissingEntries.add(warningKey);
      const warn = options.warn ?? defaultMissingEntryWarn;
      warn(
        `pyric sandbox: warning: Functions source "${configuredSource}" has no entry at ` +
          `"${configuredMain}" (${entry}); Functions triggers will not run until it is built.`,
      );
    }
    return null;
  }
  warnedMissingEntries.delete(warningKey);
  return { sourceDir, entry };
}
