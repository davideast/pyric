import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServedModule } from '../src/conformance/served-query.js';
import { CONFORMANCE_IMPORT_EVIDENCE } from '../src/conformance/.generated/can-i-use.js';

export const servedServices = ['app', 'auth', 'firestore', 'database', 'storage', 'messaging', 'ai'] as const;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const entries = join(packageRoot, 'src/serve/entries');

/** Read the bundled public value exports without evaluating a browser entry. */
export async function publicRuntimeExports(entryPoint: string): Promise<string[]> {
  const result = await build({ absWorkingDir: packageRoot,
    entryPoints: [entryPoint], bundle: true, write: false, metafile: true,
    platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  const entry = Object.values(result.metafile.outputs).find(output => output.entryPoint);
  const missingEntry = entry === undefined;
  if (missingEntry) throw new Error(`No bundled entry for ${entryPoint}`);
  // Underscore-prefixed Firebase internals are the only excluded runtime names.
  return entry.exports.filter(name => !name.startsWith('_')).sort();
}

export async function deriveServedModules(): Promise<Record<string, ServedModule>> {
  const modules: Record<string, ServedModule> = {};
  for (const service of servedServices) {
    const evidence = CONFORMANCE_IMPORT_EVIDENCE.find(entry => entry.importPath === `pyric/${service}`);
    const missingEvidence = evidence === undefined;
    if (missingEvidence) throw new Error(`Missing canonical import evidence for pyric/${service}`);
    const unsupportedPath = join(entries, 'unsupported', `${service}.ts`);
    const hasUnsupportedModule = existsSync(unsupportedPath);
    const importsOnly = hasUnsupportedModule ? await publicRuntimeExports(unsupportedPath) : [];
    modules[service] = {
      surface: evidence.surface,
      expected: await publicRuntimeExports(`firebase/${service}`),
      exports: await publicRuntimeExports(join(entries, `${service}.ts`)),
      importsOnly,
    };
  }
  return modules;
}

export async function generateServedAvailability(): Promise<void> {
  const modules = await deriveServedModules();
  const output = join(packageRoot, 'src/conformance/.generated/served-availability.ts');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, [
    '// Generated from the served runtime exports and unsupported modules. Do not edit or commit.',
    "import type { ServedModule } from '../served-query.js';",
    `export const SERVED_MODULES: Readonly<Record<string, ServedModule>> = ${JSON.stringify(modules)};`,
    '',
  ].join('\n'));
}

const isMain = import.meta.main === true;
if (isMain) await generateServedAvailability();
