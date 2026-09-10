#!/usr/bin/env bun
/**
 * Generate the SDK export name lists the vocabulary invariant checks every
 * `sdk-service` method name against.
 *
 * This is rerun by hand after a Firebase SDK upgrade, not by the build: it
 * reads the installed packages' own type declarations and writes a sorted
 * array of exported names per service, so a name invented for a method
 * record has nothing to hide behind. `firebase-js.json` and
 * `firebase-admin.json` are generated; `pyric.json` is authored by hand,
 * because pyric's method names are a design choice, not an extraction.
 *
 * Firebase's public packages re-export their `@firebase/<service>` and
 * `firebase-admin`'s own per-service modules; the type declarations these
 * scripts read are the ones the public package's `types` field points at.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/bridge/surface/sdk-names');

/** Every top-level `export declare function <name>` in a `.d.ts` file, deduplicated and sorted. */
function extractFunctionNames(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/^export declare function ([a-zA-Z_$][a-zA-Z0-9_$]*)/gm)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/**
 * Every public (non-underscore-prefixed) method name declared on a class in a
 * `.d.ts` file, read from four-space-indented `<name>(` signatures. Used for
 * `firebase-admin`'s `BaseAuth`, whose methods are the SDK surface `auth`
 * mirrors; nothing else in this generator needs a class's instance methods.
 */
function extractClassMethodNames(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/^ {4}([a-zA-Z_$][a-zA-Z0-9_$]*)\(/gm)) {
    const name = match[1]!;
    if (name.startsWith('_')) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * The directory an installed public package's own type declarations live
 * under, found by resolving one of its subpaths and walking up to the
 * `node_modules` that holds both it and its scoped implementation packages
 * (`firebase` and `@firebase/*`, or `firebase-admin` and its own `lib/`).
 */
async function packageNodeModules(specifier: string, packageName: string): Promise<string> {
  const resolved = fileURLToPath(await import.meta.resolve(specifier));
  const marker = join('node_modules', packageName);
  const index = resolved.indexOf(marker);
  if (index === -1) {
    throw new Error(`could not find '${marker}' on the resolved path for '${specifier}': ${resolved}`);
  }
  return join(resolved.slice(0, index), 'node_modules');
}

async function firebaseJsNames(): Promise<Record<string, string[]>> {
  const nodeModules = await packageNodeModules('firebase/firestore', 'firebase');
  const scoped = (service: string) => join(nodeModules, '@firebase', service);
  return {
    firestore: extractFunctionNames(join(scoped('firestore'), 'dist', 'index.d.ts')),
    database: extractFunctionNames(join(scoped('database'), 'dist', 'public.d.ts')),
    storage: extractFunctionNames(join(scoped('storage'), 'dist', 'storage-public.d.ts')),
    auth: extractFunctionNames(join(scoped('auth'), 'dist', 'auth-public.d.ts')),
  };
}

async function firebaseAdminNames(): Promise<Record<string, string[]>> {
  const nodeModules = await packageNodeModules('firebase-admin/firestore', 'firebase-admin');
  const lib = join(nodeModules, 'firebase-admin', 'lib');
  return {
    firestore: extractFunctionNames(join(lib, 'firestore', 'index.d.ts')),
    database: extractFunctionNames(join(lib, 'database', 'index.d.ts')),
    storage: extractFunctionNames(join(lib, 'storage', 'index.d.ts')),
    auth: extractClassMethodNames(join(lib, 'auth', 'base-auth.d.ts')),
  };
}

async function main(): Promise<void> {
  const js = await firebaseJsNames();
  const admin = await firebaseAdminNames();
  writeFileSync(join(OUTPUT_DIR, 'firebase-js.json'), `${JSON.stringify(js, null, 2)}\n`);
  writeFileSync(join(OUTPUT_DIR, 'firebase-admin.json'), `${JSON.stringify(admin, null, 2)}\n`);
  for (const [name, byService] of [['firebase-js', js], ['firebase-admin', admin]] as const) {
    const counts = Object.entries(byService).map(([service, names]) => `${service}=${names.length}`);
    console.log(`${name}: ${counts.join(', ')}`);
  }
}

if (import.meta.main) await main();
