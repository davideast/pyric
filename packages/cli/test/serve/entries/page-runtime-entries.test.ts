/**
 * The page runtime (`entries/runtime.ts`) deploys the project's rules before
 * app code runs, through top-level await. Every served entry whose in-page
 * fallback enforces rules must import it, or an in-page app runs with no
 * project rules at all. `firebase/auth` is the exception (see auth.test.ts).
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const ENTRIES = join(import.meta.dir, '../../../src/serve/entries');

async function moduleGraph(entry: string): Promise<string[]> {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [join(ENTRIES, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['pyric', 'pyric/*'],
    metafile: true,
  });
  return Object.keys(result.metafile.inputs);
}

describe('rules-enforcing served entries load the page runtime', () => {
  for (const entry of ['firestore.ts', 'storage.ts', 'database.ts']) {
    it(`${entry} includes runtime.ts in its module graph`, async () => {
      const graph = await moduleGraph(entry);
      const hasRuntime = graph.some((path) => path.endsWith('entries/runtime.ts'));
      expect(hasRuntime).toBe(true);
    });
  }
});
