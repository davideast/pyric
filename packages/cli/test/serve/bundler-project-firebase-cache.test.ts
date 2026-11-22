/**
 * Regression coverage for `#1544`: production AI mode's real-SDK bundle cache
 * key hashes the resolved `firebase` and `@firebase/*` package contents so
 * `patch-package` or hand edits under `node_modules/@firebase/*` invalidate the
 * warm bundle cache without `--no-cache`, while identical installs across
 * separate project directories still share one cache key.
 */
import { describe, expect, it } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  bundleSdk,
  cacheKey,
  defaultSdkEntries,
  resolveProjectFirebase,
} from '../../src/serve/bundler.js';
import { useTempDirs } from '../use-temp-dirs.js';

const makeTempDir = useTempDirs('pyric-bundler-fb-cache-');

function writePackage(
  pkgDir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(pkgDir, ...rel.split('/'));
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, content);
  }
}

function createSyntheticFirebaseProject(label: string): {
  projectDir: string;
  entry: Record<string, string>;
} {
  const root = makeTempDir(`pyric-fb-synth-${label}-`);
  const entryFile = join(root, 'entry.ts');
  writeFileSync(entryFile, 'export const entry = 1;');
  const projectDir = join(root, 'project');
  writePackage(
    join(projectDir, 'node_modules', 'firebase'),
    {
      name: 'firebase',
      version: '12.19.0',
      dependencies: {
        '@firebase/ai': '2.16.0',
        '@firebase/app': '0.16.2',
        '@firebase/app-check': '0.13.1',
      },
    },
    {
      'ai/dist/esm/index.esm.js': "export * from '@firebase/ai';\n",
      'app/dist/esm/index.esm.js': "export * from '@firebase/app';\n",
      'app-check/dist/esm/index.esm.js': "export * from '@firebase/app-check';\n",
    },
  );
  writePackage(
    join(projectDir, 'node_modules', '@firebase', 'ai'),
    {
      name: '@firebase/ai',
      version: '2.16.0',
      dependencies: {
        '@firebase/util': '1.15.3',
        '@firebase/custom-leaf': '0.1.0',
      },
    },
    {
      'dist/esm/index.esm.js': 'export const aiClient = "v1";\n',
    },
  );
  writePackage(
    join(projectDir, 'node_modules', '@firebase', 'app'),
    { name: '@firebase/app', version: '0.16.2' },
    { 'dist/esm/index.esm.js': 'export const appClient = "v1";\n' },
  );
  writePackage(
    join(projectDir, 'node_modules', '@firebase', 'app-check'),
    { name: '@firebase/app-check', version: '0.13.1' },
    { 'dist/esm/index.esm.js': 'export const appCheckClient = "v1";\n' },
  );
  writePackage(
    join(projectDir, 'node_modules', '@firebase', 'util'),
    { name: '@firebase/util', version: '1.15.3' },
    { 'dist/index.esm2017.js': 'export const utilHelper = "v1";\n' },
  );
  writePackage(
    join(projectDir, 'node_modules', '@firebase', 'custom-leaf'),
    { name: '@firebase/custom-leaf', version: '0.1.0' },
    { 'dist/index.js': 'export const leafValue = "v1";\n' },
  );
  return { projectDir, entry: { auth: entryFile } };
}

describe('production AI real-SDK cache key covers patched @firebase files (#1544)', () => {
  it('invalidates when @firebase/ai, @firebase/app, transitive @firebase/*, or firebase wrapper files change', () => {
    const { projectDir, entry } = createSyntheticFirebaseProject('edits');
    const cliGraph = makeTempDir('pyric-cli-graph-');
    const pyricRoot = makeTempDir('pyric-pkg-root-');
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliGraph, 'stub.ts'), 'export const stub = 1;');
    writeFileSync(join(pyricRoot, 'dist', 'index.js'), 'export const pyric = 1;');

    const compute = (): string =>
      cacheKey(
        { entries: entry, projectFirebase: { projectDir } },
        '1.2.3',
        cliGraph,
        pyricRoot,
      );

    const k0 = compute();

    // 1. Patch inside @firebase/ai
    writeFileSync(
      join(projectDir, 'node_modules', '@firebase', 'ai', 'dist', 'esm', 'index.esm.js'),
      'export const aiClient = "patched";\n',
    );
    const k1 = compute();
    expect(k1).not.toBe(k0);

    // 2. Patch inside @firebase/util
    writeFileSync(
      join(projectDir, 'node_modules', '@firebase', 'util', 'dist', 'index.esm2017.js'),
      'export const utilHelper = "patched";\n',
    );
    const k2 = compute();
    expect(k2).not.toBe(k1);

    // 3. Patch inside transitive @firebase/custom-leaf discovered via dependencies
    writeFileSync(
      join(projectDir, 'node_modules', '@firebase', 'custom-leaf', 'dist', 'index.js'),
      'export const leafValue = "patched";\n',
    );
    const k3 = compute();
    expect(k3).not.toBe(k2);

    // 4. Patch inside firebase/ai wrapper file
    writeFileSync(
      join(projectDir, 'node_modules', 'firebase', 'ai', 'dist', 'esm', 'index.esm.js'),
      'export const wrapperPatched = true;\n',
    );
    const k4 = compute();
    expect(k4).not.toBe(k3);
  });

  it('shares the same cache key across distinct project directories when SDK contents match', () => {
    const first = createSyntheticFirebaseProject('dir-a');
    const second = createSyntheticFirebaseProject('dir-b');
    const cliGraph = makeTempDir('pyric-cli-graph-same-');
    const pyricRoot = makeTempDir('pyric-pkg-root-same-');
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliGraph, 'stub.ts'), 'export const stub = 1;');
    writeFileSync(join(pyricRoot, 'dist', 'index.js'), 'export const pyric = 1;');

    const keyA = cacheKey(
      { entries: first.entry, projectFirebase: { projectDir: first.projectDir } },
      '1.2.3',
      cliGraph,
      pyricRoot,
    );
    const keyB = cacheKey(
      { entries: second.entry, projectFirebase: { projectDir: second.projectDir } },
      '1.2.3',
      cliGraph,
      pyricRoot,
    );
    expect(keyA).toBe(keyB);
  });

  it('follows symlinked store layouts (.pnpm / .bun) where @firebase/* sits beside realpath(firebase)', () => {
    const storeRoot = makeTempDir('pyric-symlink-store-');
    const storeNm = join(storeRoot, '.store', 'firebase@12.19.0', 'node_modules');
    writePackage(
      join(storeNm, 'firebase'),
      { name: 'firebase', version: '12.19.0' },
      { 'ai/dist/esm/index.esm.js': "export * from '@firebase/ai';\n" },
    );
    writePackage(
      join(storeNm, '@firebase', 'ai'),
      { name: '@firebase/ai', version: '2.16.0' },
      { 'dist/esm/index.esm.js': 'export const aiStore = "v1";\n' },
    );

    const projectDir = join(storeRoot, 'app');
    mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
    symlinkSync(join(storeNm, 'firebase'), join(projectDir, 'node_modules', 'firebase'), 'dir');

    const entryFile = join(storeRoot, 'entry.ts');
    writeFileSync(entryFile, 'export const entry = 1;');
    const cliGraph = makeTempDir('pyric-cli-graph-sym-');
    const pyricRoot = makeTempDir('pyric-pkg-root-sym-');
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliGraph, 'stub.ts'), 'export const stub = 1;');
    writeFileSync(join(pyricRoot, 'dist', 'index.js'), 'export const pyric = 1;');

    const before = cacheKey(
      { entries: { auth: entryFile }, projectFirebase: { projectDir } },
      '1.2.3',
      cliGraph,
      pyricRoot,
    );
    writeFileSync(
      join(storeNm, '@firebase', 'ai', 'dist', 'esm', 'index.esm.js'),
      'export const aiStore = "v2-patched";\n',
    );
    const after = cacheKey(
      { entries: { auth: entryFile }, projectFirebase: { projectDir } },
      '1.2.3',
      cliGraph,
      pyricRoot,
    );
    expect(after).not.toBe(before);
  });

  it('rebuilds the real Firebase SDK bundle without --no-cache after patching @firebase/ai', async () => {
    const work = makeTempDir('pyric-real-bundle-patch-');
    const projectDir = join(work, 'app');
    mkdirSync(join(projectDir, 'node_modules', '@firebase'), { recursive: true });

    const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
    const realFirebase = realpathSync(resolveProjectFirebase(repoRoot).root);
    const bunStoreNm = join(realFirebase, '..');
    const fbDest = join(projectDir, 'node_modules', 'firebase');
    mkdirSync(fbDest, { recursive: true });
    cpSync(join(realFirebase, 'package.json'), join(fbDest, 'package.json'));
    for (const folder of ['ai', 'app', 'app-check']) {
      cpSync(join(realFirebase, folder), join(fbDest, folder), {
        recursive: true,
        dereference: true,
      });
    }

    // Copy only @firebase/ai so we can patch it in place; symlink every other
    // package from the workspace store so test setup does zero bulk file copies.
    const realAi = realpathSync(join(bunStoreNm, '@firebase', 'ai'));
    mkdirSync(join(projectDir, 'node_modules', '@firebase', 'ai', 'dist', 'esm'), {
      recursive: true,
    });
    cpSync(
      join(realAi, 'package.json'),
      join(projectDir, 'node_modules', '@firebase', 'ai', 'package.json'),
    );
    cpSync(
      join(realAi, 'dist', 'esm'),
      join(projectDir, 'node_modules', '@firebase', 'ai', 'dist', 'esm'),
      { recursive: true, dereference: true },
    );

    for (const seed of ['ai', 'app', 'app-check']) {
      const seedReal = realpathSync(join(bunStoreNm, '@firebase', seed));
      if (seed !== 'ai') {
        const dest = join(projectDir, 'node_modules', '@firebase', seed);
        try {
          symlinkSync(seedReal, dest, 'dir');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const depStoreNm = join(seedReal, '..', '..');
      for (const name of readdirSync(depStoreNm)) {
        if (name === '@firebase') {
          const scoped = join(depStoreNm, '@firebase');
          for (const sub of readdirSync(scoped)) {
            if (sub === 'ai') continue;
            const target = join(projectDir, 'node_modules', '@firebase', sub);
            try {
              symlinkSync(realpathSync(join(scoped, sub)), target, 'dir');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          }
        } else {
          const target = join(projectDir, 'node_modules', name);
          try {
            symlinkSync(realpathSync(join(depStoreNm, name)), target, 'dir');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
      }
    }

    const cacheRoot = join(work, 'cache');
    const allEntries = defaultSdkEntries();
    const entries = {
      'app-ai-passthrough': allEntries['app-ai-passthrough'] ?? '',
      'app-ai-passthrough-app-check': allEntries['app-ai-passthrough-app-check'] ?? '',
    };
    const first = await bundleSdk({
      entries,
      cacheRoot,
      minify: false,
      projectFirebase: { projectDir },
    });
    expect(first.cached).toBe(false);

    const warmHit = await bundleSdk({
      entries,
      cacheRoot,
      minify: false,
      projectFirebase: { projectDir },
    });
    expect(warmHit.cached).toBe(true);

    const aiEsm = join(projectDir, 'node_modules', '@firebase', 'ai', 'dist', 'esm', 'index.esm.js');
    writeFileSync(
      aiEsm,
      `${readFileSync(aiEsm, 'utf8')}\nglobalThis.__pyricPatchedAi1544 = "patched-ai-1544";\n`,
    );

    const rebuilt = await bundleSdk({
      entries,
      cacheRoot,
      minify: false,
      projectFirebase: { projectDir },
    });
    expect(rebuilt.cached).toBe(false);
    expect(rebuilt.outDir).not.toBe(first.outDir);
    const sdkFiles = readdirSync(rebuilt.outDir).filter(
      (name) => name.startsWith('firebase-sdk-') && name.endsWith('.js'),
    );
    const containsPatch = sdkFiles.some((name) =>
      readFileSync(join(rebuilt.outDir, name), 'utf8').includes('patched-ai-1544'),
    );
    expect(containsPatch).toBe(true);
  }, 30_000);
});
