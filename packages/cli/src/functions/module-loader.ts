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
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function usesCommonJs(entry: string): boolean {
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
    return createRequire(entry)(entry) as Record<string, unknown>;
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}
