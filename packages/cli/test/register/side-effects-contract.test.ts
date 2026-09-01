/**
 * TA.2 — the `sideEffects` contract that keeps `@pyric/cli/register` and the
 * `pyric` swap entries out of a bundler's tree-shaking pass.
 *
 * `@pyric/cli/register` installs Node resolution hooks and the sandbox-factory
 * global purely at import time; app code imports it for effect only
 * (`import '@pyric/cli/register'`, no bindings used). A bundler that considers
 * the package side-effect-free deletes that import outright and silently
 * removes the whole sandbox interception layer.
 *
 * Measured with esbuild 0.28 (`packages/cli/node_modules/esbuild`, a direct
 * dependency, so this runs for real rather than as a documented manual check):
 *   - no `sideEffects` field  → import SURVIVES (esbuild assumes side effects)
 *   - `"sideEffects": false`  → import PRUNED (bundle collapses to 46 bytes)
 *   - explicit allowlist      → import SURVIVES
 * So the field is defence-in-depth: it pins the contract before someone adds
 * `"sideEffects": false` for bundle-size wins and silently disarms the sandbox.
 *
 * The same measurement on a swap entry (`firebase/auth` aliased to
 * `serve/entries/auth.*`, as vite-module-swap and the Next client aliases do)
 * is starker: with the entry omitted from the allowlist the 184 KB graph
 * collapses to ZERO bytes, because `auth.*`'s `import './init.js'` is its only
 * edge to the sign-in helper and the runtime chip. That is why the globs below
 * cover `serve/entries/` in BOTH `dist/` and `src/` — `files` publishes both,
 * and `defaultSdkEntries()` resolves the `.ts` entries in workspace mode.
 *
 * (`bundleSdk`'s own esbuild pass is unaffected either way — with
 * `splitting: true` every entry, `init` included, is an explicit entry point,
 * so its output is byte-identical across all four manifest states.)
 *
 * The manifest assertions below are the guard; the esbuild cases prove both
 * that the current manifests preserve the entries AND that the field is
 * load-bearing (the negative control re-runs the same module content under
 * `"sideEffects": false` in a throwaway package and asserts it is pruned).
 */
import { describe, expect, it } from 'bun:test';
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PYRIC_ROOT = fileURLToPath(new URL('../../../pyric/', import.meta.url));

interface Manifest {
  readonly name: string;
  readonly sideEffects?: unknown;
}

function manifestAt(packageRoot: string): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Manifest;
}

function sideEffectsOf(packageRoot: string): string[] {
  const declared = manifestAt(packageRoot).sideEffects;
  expect(Array.isArray(declared)).toBe(true);
  return declared as string[];
}

/** Externalize everything the probed entry pulls in, so the bundle is the
 *  entry's own graph and needs no installed dependencies. Package-internal
 *  specifiers still resolve normally — that is what the `sideEffects` lookup
 *  keys off. */
function externalizeBare(
  keep: readonly string[],
  externalizeRelativeFrom?: string,
): esbuild.Plugin {
  return {
    name: 'externalize-bare',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (keep.some((prefix) => args.path === prefix || args.path.startsWith(`${prefix}/`))) {
          return null;
        }
        return { external: true };
      });
      if (externalizeRelativeFrom !== undefined) {
        // The negative-control probe is one file copied out of its package, so
        // its relative siblings do not exist. Only the probe's OWN module body
        // matters — whether the import edge to it survives.
        build.onResolve({ filter: /^\./ }, (args) =>
          args.importer.startsWith(externalizeRelativeFrom) ? { external: true } : null,
        );
      }
    },
  };
}

/** Bundle `import '<specifier>';` with tree-shaking on and return the output. */
async function bundleSideEffectOnlyImport(options: {
  readonly dir: string;
  readonly specifier: string;
  readonly keep: readonly string[];
  readonly externalizeRelativeFrom?: string;
  readonly alias?: Record<string, string>;
  readonly platform?: 'node' | 'browser';
}): Promise<string> {
  const entry = join(options.dir, 'fixture.mjs');
  writeFileSync(entry, `import '${options.specifier}';\n`);
  const outfile = join(options.dir, 'out.js');
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: options.platform ?? 'node',
    treeShaking: true,
    logLevel: 'silent',
    conditions: ['node', 'import'],
    alias: options.alias,
    plugins: [externalizeBare(options.keep, options.externalizeRelativeFrom)],
  });
  expect(result.errors).toEqual([]);
  return readFileSync(outfile, 'utf8');
}

/** A scratch dir whose `node_modules` links the workspace package under test,
 *  so the probe resolves through the real exports map and the real manifest. */
function scratchLinking(packageName: string, target: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-side-effects-'));
  const linkPath = join(dir, 'node_modules', packageName);
  mkdirSync(join(linkPath, '..'), { recursive: true });
  symlinkSync(target.replace(/\/$/, ''), linkPath, 'dir');
  return dir;
}

describe('sideEffects manifest contract', () => {
  it('@pyric/cli declares the register seam and the served swap entries', () => {
    const declared = sideEffectsOf(CLI_ROOT);
    // The Node substitution seam: installs module.registerHooks + the
    // `pyric.remote.sandboxFactory` global at import time.
    expect(declared).toContain('./dist/register/index.js');
    expect(declared).toContain('./src/register/index.ts');
    // The browser-injected swap entries `pyric dev` serves for `firebase/*`.
    // `auth`/`firestore`/`database`/`storage` each carry a bare
    // `import './init.js'` whose only purpose is the effect, and the CLI's own
    // esbuild pass over this directory would drop it under a tighter list.
    expect(declared).toContain('./dist/serve/entries/*.js');
    expect(declared).toContain('./src/serve/entries/*.ts');
  });

  it('pyric declares the register entry and every import-time registration module', () => {
    const declared = sideEffectsOf(PYRIC_ROOT);
    for (const entry of [
      // Declared swap entry (`pyric/app/register` in the exports map).
      'app/register',
      // `installDefaultAppResolver(getApp)` at module scope.
      'app/registry',
      // `installClientAppAdapter({ ... })` at module scope.
      'app/runtime',
      // `registerDefaultConverters()` at module scope.
      'firestore/sandbox/write-runtime',
      // `semantics.addOperation('toAST', ...)` at module scope.
      'rules/grammar/FirestoreParser',
      // `registerOnSnapshotImpl` / `registerRemoteOnSnapshotImpl` at module scope.
      'sandbox/admin-firestore/listeners',
      // `Object.defineProperty(FirebaseError, 'name', ...)` at module scope.
      'sandbox/internal/firebase-error',
    ]) {
      expect(declared).toContain(`./dist/${entry}.js`);
      expect(declared).toContain(`./src/${entry}.ts`);
    }
  });

  it('never regresses to the blanket "sideEffects": false', () => {
    for (const root of [CLI_ROOT, PYRIC_ROOT]) {
      expect(manifestAt(root).sideEffects).not.toBe(false);
    }
  });

  it('lists no dead paths — every declared glob matches a real file', () => {
    for (const root of [CLI_ROOT, PYRIC_ROOT]) {
      for (const pattern of sideEffectsOf(root)) {
        expect(pattern.startsWith('./')).toBe(true);
        const relative = pattern.slice(2);
        const matched = relative.includes('*')
          ? [...new Bun.Glob(relative).scanSync({ cwd: root })].length > 0
          : existsSync(join(root, relative));
        expect(`${manifestAt(root).name}:${pattern}=${matched}`).toBe(
          `${manifestAt(root).name}:${pattern}=true`,
        );
      }
    }
  });
});

describe('sideEffects survives a real tree-shaking pass', () => {
  it("keeps @pyric/cli/register's hook installation and sandbox-factory global", async () => {
    const dir = scratchLinking('@pyric/cli', CLI_ROOT);
    const output = await bundleSideEffectOnlyImport({
      dir,
      specifier: '@pyric/cli/register',
      keep: ['@pyric', 'pyric'],
    });
    expect(output).toContain('registerHooks');
    expect(output).toContain('PYRIC_SANDBOX');
    expect(output).toContain('pyric.remote.sandboxFactory');
  }, 60_000);

  it('keeps the pyric/app/register swap entry', async () => {
    const dir = scratchLinking('pyric', PYRIC_ROOT);
    const output = await bundleSideEffectOnlyImport({
      dir,
      specifier: 'pyric/app/register',
      keep: ['pyric'],
    });
    expect(output).toContain('installDefaultAppResolver');
  }, 60_000);

  // The swap entries are aliased in as `firebase/*` (vite-module-swap /
  // next client aliases), so app code reaches them through a bare
  // `import 'firebase/auth'` with no bindings used — a single-entry,
  // no-splitting graph where an unlisted entry collapses to ZERO bytes.
  for (const [layout, entry] of [
    ['dist', 'dist/serve/entries/auth.js'],
    ['src', 'src/serve/entries/auth.ts'],
  ] as const) {
    it(`keeps the ${layout} firebase/auth swap entry and its init graph`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pyric-side-effects-swap-'));
      const output = await bundleSideEffectOnlyImport({
        dir,
        specifier: 'firebase/auth',
        // Let only the aliased specifier through to esbuild's own resolver
        // (which applies `alias`); everything else the entry pulls in is
        // externalized so the probe needs no installed dependencies.
        keep: ['firebase/auth'],
        alias: { 'firebase/auth': join(CLI_ROOT, entry) },
        platform: 'browser',
      });
      expect(output.length).toBeGreaterThan(1_000);
      // `./init.js` is imported for effect only — it mounts the sign-in helper
      // and the runtime chip. Its graph must not be shaken out.
      expect(output).toMatch(/auth-helper|pyric-auth|installPyricRuntimeChip|runtime-chip/i);
    }, 60_000);
  }

  it('NEGATIVE CONTROL: the same register module is pruned under "sideEffects": false', async () => {
    // Same module bytes, throwaway package, only the manifest field differs —
    // this is the future footgun the declarations above exist to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'pyric-side-effects-neg-'));
    const probe = join(dir, 'node_modules', 'probe-register');
    mkdirSync(probe, { recursive: true });
    const registerSource = readFileSync(join(CLI_ROOT, 'dist/register/index.js'), 'utf8');
    writeFileSync(join(probe, 'index.js'), registerSource);

    const bundleWith = async (sideEffects: unknown): Promise<string> => {
      writeFileSync(
        join(probe, 'package.json'),
        JSON.stringify({ name: 'probe-register', type: 'module', main: 'index.js', sideEffects }),
      );
      return bundleSideEffectOnlyImport({
        dir,
        specifier: 'probe-register',
        keep: ['probe-register'],
        externalizeRelativeFrom: probe,
      });
    };

    const pruned = await bundleWith(false);
    expect(pruned).not.toContain('registerHooks');
    expect(pruned).not.toContain('pyric.remote.sandboxFactory');

    const preserved = await bundleWith(['./index.js']);
    expect(preserved).toContain('registerHooks');
    expect(preserved).toContain('pyric.remote.sandboxFactory');
  }, 60_000);
});

// Keep the resolved roots honest: a moved test file must fail loudly, not
// silently assert against an empty manifest.
describe('probe roots', () => {
  it('points at the two publishable manifests', () => {
    expect(manifestAt(CLI_ROOT).name).toBe('@pyric/cli');
    expect(manifestAt(PYRIC_ROOT).name).toBe('pyric');
    expect(existsSync(join(CLI_ROOT, 'dist/register/index.js'))).toBe(true);
  });
});
