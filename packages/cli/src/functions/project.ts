import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_FUNCTIONS_CODEBASE,
  extractFunctionsCodebases,
  type FirebaseJson,
} from '../cli/firebase-json.js';

export interface FunctionsCodebaseProject {
  codebase: string;
  sourceDir: string;
  entry: string;
}

export interface FunctionsProject {
  sourceDir: string;
  entry: string;
  /** Codebase identifier when explicitly declared or when multiple codebases are configured. */
  codebase?: string;
  /** All runnable codebases when declared via array or explicit codebase config. */
  codebases?: readonly FunctionsCodebaseProject[];
}

export interface DiscoverFunctionsProjectOptions {
  warn?: (message: string) => void;
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

function readFunctionsFirebaseJson(cwd: string): FirebaseJson | null {
  const firebaseJsonPath = join(cwd, 'firebase.json');
  if (!existsSync(firebaseJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as FirebaseJson;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `pyric sandbox: failed to parse firebase.json while discovering Functions: ${detail}`,
    );
  }
}

function formatCodebaseSuffix(codebase: string, includeLabel: boolean): string {
  if (!includeLabel) return '';
  return ` (codebase "${codebase}")`;
}

/** Normalize a discovered `FunctionsProject` into its list of codebase entries. */
export function codebasesOfFunctionsProject(
  project: FunctionsProject,
): FunctionsCodebaseProject[] {
  if (project.codebases !== undefined && project.codebases.length > 0) {
    return [...project.codebases];
  }
  return [
    {
      codebase: project.codebase ?? DEFAULT_FUNCTIONS_CODEBASE,
      sourceDir: project.sourceDir,
      entry: project.entry,
    },
  ];
}

/**
 * Discover all runnable Node Functions codebases declared in `firebase.json`.
 * Supports both single-object `functions` and multi-codebase `functions` arrays.
 */
export function discoverFunctionsProjects(
  cwd: string,
  options: DiscoverFunctionsProjectOptions = {},
): FunctionsCodebaseProject[] {
  const config = readFunctionsFirebaseJson(cwd);
  if (config === null) return [];

  const declared = extractFunctionsCodebases(config);
  if (declared.length === 0) return [];

  const isMulti = declared.length > 1;
  const resolvedSourceDirs = new Map<string, string>();
  const resolvedList: Array<{ codebase: string; configuredSource: string; sourceDir: string }> = [];

  for (const item of declared) {
    const sourceDir = resolve(cwd, item.source);
    const prior = resolvedSourceDirs.get(sourceDir);
    if (prior !== undefined) {
      throw new Error(
        `pyric sandbox: firebase.json declares duplicate Functions source directory ` +
          `"${sourceDir}" for codebases "${prior}" and "${item.codebase}".`,
      );
    }
    resolvedSourceDirs.set(sourceDir, item.codebase);
    resolvedList.push({
      codebase: item.codebase,
      configuredSource: item.source,
      sourceDir,
    });
  }

  const runnable: FunctionsCodebaseProject[] = [];
  for (const { codebase, configuredSource, sourceDir } of resolvedList) {
    const includeLabel = isMulti || codebase !== DEFAULT_FUNCTIONS_CODEBASE;
    const codebaseLabel = formatCodebaseSuffix(codebase, includeLabel);
    const packageJsonPath = join(sourceDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `pyric sandbox: Functions source${codebaseLabel} is declared but ${packageJsonPath} does not exist.`,
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
    const warningKey = `${codebase}\0${sourceDir}\0${entry}`;
    if (!isExistingEntryFile(entry)) {
      if (!warnedMissingEntries.has(warningKey)) {
        warnedMissingEntries.add(warningKey);
        const warn = options.warn ?? defaultMissingEntryWarn;
        warn(
          `pyric sandbox: warning: Functions source "${configuredSource}"${codebaseLabel} has no entry at ` +
            `"${configuredMain}" (${entry}); Functions triggers will not run until it is built.`,
        );
      }
      continue;
    }
    warnedMissingEntries.delete(warningKey);
    runnable.push({ codebase, sourceDir, entry });
  }

  return runnable;
}

/**
 * Discover the Functions project(s) configured in `firebase.json`.
 * Preserves the legacy `{ sourceDir, entry }` return shape for default
 * single-object configs, and attaches `codebase` / `codebases` metadata
 * for multi-codebase arrays or explicitly named codebases.
 */
export function discoverFunctionsProject(
  cwd: string,
  options: DiscoverFunctionsProjectOptions = {},
): FunctionsProject | null {
  const config = readFunctionsFirebaseJson(cwd);
  if (config === null) return null;

  const isArrayConfig = Array.isArray(config.functions);
  const rawCodebase =
    !isArrayConfig && typeof config.functions === 'object' && config.functions !== null
      ? (config.functions as { codebase?: unknown }).codebase
      : undefined;
  const hasExplicitCodebase = typeof rawCodebase === 'string' && rawCodebase.length > 0;

  const runnable = discoverFunctionsProjects(cwd, options);
  const first = runnable[0];
  if (first === undefined) return null;

  if (!isArrayConfig && !hasExplicitCodebase && runnable.length === 1) {
    return { sourceDir: first.sourceDir, entry: first.entry };
  }

  return {
    sourceDir: first.sourceDir,
    entry: first.entry,
    codebase: first.codebase,
    codebases: runnable,
  };
}
