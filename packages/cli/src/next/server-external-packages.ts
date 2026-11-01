/**
 * Server module externalization logic for Next.js runtime loader interception.
 *
 * Next bundles a server route's imports unless `serverExternalPackages` names
 * them, and a bundled import never reaches Node's resolver, so the register
 * never sees it. Both bundlers match that list by the name a module is
 * imported by: webpack by the `node_modules/<name>/` folder a request resolves
 * into, Turbopack by the request's package name. So the list holds every name
 * a Firebase SDK is installed under (#1626): each top-level entry of each
 * `node_modules` folder Node searches from the project whose `package.json`
 * names a Firebase SDK, by the register's own check (`isFirebaseSdkName`).
 * That covers `firebase`, `firebase-admin`, every `@firebase/*` package, and
 * npm aliases such as `"admin": "npm:firebase-admin@13"`, whether the app, a
 * workspace package or another dependency declares them.
 *
 * The project is `process.cwd()`. Next passes the config function no project
 * directory, so `next dev <dir>` run from elsewhere scans the wrong folders;
 * {@link projectDirWarning} says so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NextConfigObject } from './types.js';
import { pyricExternalPackages } from '../bundler/externals.js';
import { manifestNameAt } from '../register/package-identity.js';
import { isFirebaseSdkName } from '../register/swap-or-stop.js';

const LOG_PREFIX = '@pyric/cli/next';
const NEXT_CONFIG_FILES = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts', 'next.config.cts'];

/** Where the scan for installed Firebase SDKs starts, and the last directory it searches. */
export interface ExternalsScan {
  /** The directory Next runs in. */
  readonly projectDir: string;
  /** The last directory whose `node_modules` is searched. Defaults to the filesystem root. */
  readonly stopDir?: string;
}

/** Each `node_modules` folder Node searches from `scan.projectDir`, nearest first. */
function nodeModulesFolders(scan: ExternalsScan): string[] {
  const folders: string[] = [];
  let directory = scan.projectDir;
  for (;;) {
    folders.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    const isLastDirectory = directory === scan.stopDir || parent === directory;
    if (isLastDirectory) return folders;
    directory = parent;
  }
}

function sortedEntries(folder: string): string[] {
  try {
    return readdirSync(folder).filter((entry) => !entry.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** The package folders directly in `folder`: `name`, and `@scope/name` for each scope. */
function topLevelPackages(folder: string): string[] {
  return sortedEntries(folder).flatMap((entry) => {
    const isScope = entry.startsWith('@');
    if (!isScope) return [entry];
    return sortedEntries(join(folder, entry)).map((scoped) => `${entry}/${scoped}`);
  });
}

/** Whether `folder/entry` is a Firebase SDK, by the name in its own `package.json` only. */
function isInstalledFirebaseSdk(folder: string, entry: string): boolean {
  return isFirebaseSdkName(manifestNameAt(join(folder, entry)));
}

/**
 * The names a Next server route can import a Firebase SDK by: `firebase` and
 * `firebase-admin`, then each name a Firebase SDK is installed under.
 */
function firebaseServerExternals(scan: ExternalsScan): string[] {
  const installed = nodeModulesFolders(scan).flatMap((folder) =>
    topLevelPackages(folder).filter((entry) => isInstalledFirebaseSdk(folder, entry)));
  return Array.from(new Set([...pyricExternalPackages, ...installed]));
}

/**
 * A warning when `cwd` holds no `next.config.*`, as under `next dev <dir>` run
 * from another directory: the scan then starts in the wrong place and can
 * miss a Firebase SDK installed under another name, which Next would bundle.
 */
export function projectDirWarning(cwd: string): string | null {
  const hasNextConfig = NEXT_CONFIG_FILES.some((file) => existsSync(join(cwd, file)));
  if (hasNextConfig) return null;
  return [
    `${LOG_PREFIX}: no next.config file in ${cwd}, the directory this process runs in.`,
    'withPyric finds the Firebase SDKs to keep out of server bundles from there, and Next does not tell it the project directory.',
    'Run `next dev` from the project directory, so an aliased firebase-admin or a direct @firebase/* import reaches the register.',
  ].join('\n');
}

/**
 * Refuses a config whose `transpilePackages` lists a package withPyric keeps
 * external. Next would refuse it too, without naming pyric.
 */
function refuseTranspiledSdk(config: NextConfigObject, targetPackages: readonly string[]): void {
  const transpiled: unknown[] = Array.isArray(config.transpilePackages) ? config.transpilePackages : [];
  const conflicts = transpiled.filter((pkg): pkg is string => typeof pkg === 'string' && targetPackages.includes(pkg));
  if (conflicts.length === 0) return;
  const names = conflicts.map((pkg) => `'${pkg}'`).join(', ');
  throw new Error([
    `${LOG_PREFIX}: transpilePackages lists ${names}, a Firebase SDK withPyric keeps out of server bundles.`,
    'Next bundles a transpiled package, so @pyric/cli/register would never see it and the real SDK would run.',
    `Remove ${names} from transpilePackages while the app runs under pyric sandbox.`,
  ].join('\n'));
}

function appendExternalPackages(existingPackages: unknown, targetPackages: readonly string[]): string[] {
  const packageSet = new Set<string>();
  if (Array.isArray(existingPackages)) {
    for (const pkg of existingPackages) {
      if (typeof pkg === 'string') {
        packageSet.add(pkg);
      }
    }
  }
  for (const pkg of targetPackages) {
    packageSet.add(pkg);
  }
  return Array.from(packageSet);
}

/**
 * Inject Pyric backend target packages into `serverExternalPackages` so Next.js
 * avoids inlining them during Server Component and API Route bundling. The
 * scan starts in `process.cwd()` by default.
 */
export function augmentServerExternalPackages(
  config: NextConfigObject,
  scan: ExternalsScan = { projectDir: process.cwd() },
): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const targetPackages = firebaseServerExternals(scan);
  refuseTranspiledSdk(updatedConfig, targetPackages);

  const currentExternalPackages = updatedConfig.serverExternalPackages;
  updatedConfig.serverExternalPackages = appendExternalPackages(currentExternalPackages, targetPackages);

  const hasExperimentalSection = typeof updatedConfig.experimental === 'object' && updatedConfig.experimental !== null;
  const shouldAugmentLegacySection = hasExperimentalSection || updatedConfig.serverExternalPackages === undefined;
  if (shouldAugmentLegacySection) {
    const experimentalSection = hasExperimentalSection ? Object.assign({}, updatedConfig.experimental) : {};
    const legacyPackages = experimentalSection.serverComponentsExternalPackages;
    experimentalSection.serverComponentsExternalPackages = appendExternalPackages(legacyPackages, targetPackages);
    updatedConfig.experimental = experimentalSection;
  }

  return updatedConfig;
}
