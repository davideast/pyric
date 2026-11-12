/**
 * Load a Functions source's exports in-process, the same module-system
 * detection the isolated child uses: `.cjs` and `.mjs` decide by extension,
 * anything else follows the nearest `package.json`'s `type` field.
 *
 * The child runtime loads a source into its own process because a
 * long-running trigger listener has to survive a bad reload without taking
 * the host down with it. A single synthetic call has no such lifetime: it
 * loads the module, runs one handler, and returns, so it does that in the
 * same process as the caller rather than paying for a child process per call.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

let esmReloadCounter = 0;

/** Whether `entry` is CommonJS: `.cjs`, or not `.mjs` and under a `package.json` whose `type` is not `module`. */
export function usesCommonJs(entry: string): boolean {
  const extension = extname(entry);
  if (extension === '.cjs') return true;
  if (extension === '.mjs') return false;

  let directory = dirname(entry);
  while (true) {
    const packageJsonPath = join(directory, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        type?: unknown;
      };
      return packageJson.type !== 'module';
    }
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

/** Load a Functions entry module's exports with the semantics its own scope selects. */
export async function loadFunctionsModuleExports(entry: string): Promise<Record<string, unknown>> {
  if (usesCommonJs(entry)) {
    const req = createRequire(entry);
    try {
      const resolved = req.resolve(entry);
      delete req.cache[resolved];
    } catch {
      // Let the require call below surface any resolution error verbatim.
    }
    return req(entry) as Record<string, unknown>;
  }
  let stamp = `${++esmReloadCounter}`;
  try {
    stamp = `${statSync(entry).mtimeMs}-${++esmReloadCounter}`;
  } catch {
    // Missing file will reject on import below.
  }
  const url = pathToFileURL(entry);
  url.searchParams.set('pyricReload', stamp);
  return (await import(url.href)) as Record<string, unknown>;
}
