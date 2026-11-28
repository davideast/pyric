/**
 * Lazy runtime loader for `@pyric/rules/experimental/policy` and standalone
 * ES module verification via temp `.mjs` file URLs (`pathToFileURL`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PolicyExperimentalApi } from './types.js';

interface RulesManifest {
  exports?: Record<string, { import?: string } | string>;
}

let cachedApi: Promise<PolicyExperimentalApi> | undefined;

function resolveRulesPackageJson(): string {
  const localReq = createRequire(import.meta.url);
  try {
    return localReq.resolve('@pyric/rules/package.json');
  } catch {
    // Fall through to resolve via direct dependency `pyric`.
  }
  const pyricPkg = localReq.resolve('pyric/package.json');
  return createRequire(pyricPkg).resolve('@pyric/rules/package.json');
}

function resolvePolicyEntryPath(rulesPkgPath: string): string {
  const manifest = JSON.parse(readFileSync(rulesPkgPath, 'utf8')) as RulesManifest;
  const exportEntry = manifest.exports?.['./experimental/policy'];
  const relImport =
    typeof exportEntry === 'string' ? exportEntry : exportEntry?.import;
  if (typeof relImport !== 'string' || relImport.length === 0) {
    throw new Error(
      `@pyric/rules manifest at ${rulesPkgPath} does not export './experimental/policy'`,
    );
  }
  const entryPath = resolve(dirname(rulesPkgPath), relImport);
  if (!existsSync(entryPath)) {
    throw new Error(
      `Missing built policy compiler at ${entryPath}. Run \`bun run --cwd packages/rules build\` first.`,
    );
  }
  return entryPath;
}

export async function loadPolicyExperimentalApi(): Promise<PolicyExperimentalApi> {
  if (cachedApi === undefined) {
    cachedApi = (async () => {
      const rulesPkgPath = resolveRulesPackageJson();
      const entryPath = resolvePolicyEntryPath(rulesPkgPath);
      const entryUrl = pathToFileURL(entryPath).href;
      return (await import(entryUrl)) as PolicyExperimentalApi;
    })().catch((err: unknown) => {
      cachedApi = undefined;
      throw err;
    });
  }
  return cachedApi;
}

/**
 * Verify that an emitted standalone ES module loads cleanly as a real `.mjs`
 * file via `pathToFileURL` (never a `data:` URI, for Bun 1.3.11+ and Node
 * 22/24 compatibility) and exposes every expected export as a function.
 */
export async function verifyStandaloneModuleEsm(
  moduleSource: string,
  expectedExports: readonly string[],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pyric-policy-esm-'));
  const filePath = join(dir, 'module.mjs');
  try {
    await writeFile(filePath, moduleSource, 'utf8');
    const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
    for (const name of expectedExports) {
      if (typeof mod[name] !== 'function') {
        throw new Error(`Standalone ES module is missing expected function export '${name}'`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
