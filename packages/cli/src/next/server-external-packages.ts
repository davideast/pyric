/**
 * Server module externalization logic for Next.js runtime loader interception.
 *
 * Next bundles a server route's imports unless `serverExternalPackages` names
 * them, and a bundled import never reaches Node's resolver, so the register
 * never sees it. Both bundlers match that list by the name the app imports:
 * webpack by the `node_modules/<name>/` folder a request resolves into,
 * Turbopack by the request's package name. So the list holds every name the
 * app can import a Firebase SDK by, not only `firebase` and `firebase-admin`
 * (#1626):
 *
 * - each dependency whose installed `package.json` names a Firebase SDK, by
 *   the register's own check (`isFirebaseSdkName`), which catches npm aliases
 *   such as `"admin": "npm:firebase-admin@13"`;
 * - each installed `@firebase/*` package, since the list takes names, not
 *   scopes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NextConfigObject } from './types.js';
import { pyricExternalPackages } from '../bundler/externals.js';
import { packageNameOf } from '../register/package-identity.js';
import { isFirebaseSdkName } from '../register/swap-or-stop.js';

const FIREBASE_SCOPE = '@firebase';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Each `node_modules` folder Node searches from `projectDir`, nearest first. */
function nodeModulesFolders(projectDir: string): string[] {
  const folders: string[] = [];
  let directory = projectDir;
  for (;;) {
    folders.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    const isFilesystemRoot = parent === directory;
    if (isFilesystemRoot) return folders;
    directory = parent;
  }
}

/** The names the project's own `package.json` lists as dependencies. */
function declaredDependencies(projectDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    return DEPENDENCY_FIELDS.flatMap((field) => {
      const section = manifest[field];
      const isSection = typeof section === 'object' && section !== null;
      return isSection ? Object.keys(section) : [];
    });
  } catch {
    return [];
  }
}

/** The `name` in the installed manifest of `dependency`, as Node would find it from `projectDir`. */
function installedName(dependency: string, folders: readonly string[]): string | null {
  for (const folder of folders) {
    const manifest = join(folder, dependency, 'package.json');
    if (existsSync(manifest)) return packageNameOf(pathToFileURL(manifest).href);
  }
  return null;
}

/** Every `@firebase/*` package installed in `folders`. */
function installedScopePackages(folders: readonly string[]): string[] {
  return folders.flatMap((folder) => {
    try {
      return readdirSync(join(folder, FIREBASE_SCOPE)).map((entry) => `${FIREBASE_SCOPE}/${entry}`);
    } catch {
      return [];
    }
  });
}

/**
 * The names a Next server route in `projectDir` can import a Firebase SDK by:
 * `firebase` and `firebase-admin`, each dependency installed as a Firebase SDK
 * under another name, and each installed `@firebase/*` package.
 */
function firebaseServerExternals(projectDir: string): string[] {
  const folders = nodeModulesFolders(projectDir);
  const sdkDependencies = declaredDependencies(projectDir)
    .filter((dependency) => isFirebaseSdkName(installedName(dependency, folders)));
  const names = [...pyricExternalPackages, ...sdkDependencies, ...installedScopePackages(folders)];
  return Array.from(new Set(names));
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
 * avoids inlining them during Server Component and API Route bundling.
 * `projectDir` is where Next runs, `process.cwd()` by default.
 */
export function augmentServerExternalPackages(config: NextConfigObject, projectDir: string = process.cwd()): NextConfigObject {
  const updatedConfig: NextConfigObject = Object.assign({}, config);
  const targetPackages = firebaseServerExternals(projectDir);

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
