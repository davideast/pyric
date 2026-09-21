import { expect, test } from 'bun:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const services = ['app', 'auth', 'firestore', 'database', 'storage', 'messaging', 'ai'] as const;
const entries = new URL('../../../../src/serve/entries/', import.meta.url);

async function publicRuntimeExports(entryPoint: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entryPoint], bundle: true, write: false, metafile: true,
    platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  const entry = Object.values(result.metafile.outputs).find(output => output.entryPoint);
  if (!entry) throw new Error(`No bundled entry for ${entryPoint}`);
  // Underscore-prefixed exports are Firebase internals, not public runtime names.
  // There are no other exclusions: classes and values count as well as functions.
  return entry.exports.filter(name => !name.startsWith('_')).sort();
}

for (const service of services) {
  test(`served firebase/${service} exports every public runtime name from the installed SDK`, async () => {
    const expected = await publicRuntimeExports(`firebase/${service}`);
    const actual = new Set(await publicRuntimeExports(fileURLToPath(new URL(`${service}.ts`, entries))));
    const missing = expected.filter(name => !actual.has(name));
    expect(missing, `Missing served firebase/${service} exports: ${missing.join(', ')}`).toEqual([]);
  });
}
