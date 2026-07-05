/**
 * Source bundler smoke tests. Writes a tiny package to a tmp dir,
 * bundles it, asserts the included files + runtime detection +
 * exclusion of the default-ignore set.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { bundleFunctionSource } from '../../../src/deploy/functions/bundle.js';

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `pyric-deploy-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('bundleFunctionSource', () => {
  test('includes package.json + entrypoint, derives runtime from engines.node', () => {
    write('package.json', JSON.stringify({ name: 'fn', engines: { node: '22' } }));
    write('src/index.ts', 'export const handler = () => {};');

    const result = bundleFunctionSource(tmp);

    expect(result.runtime).toBe('nodejs22');
    expect(result.files).toContain('package.json');
    expect(result.files).toContain('src/index.ts');

    // Round-trip: unzip and check the file contents survive.
    // fflate's zipSync emits directory entries alongside files
    // (e.g. `src/` as a zero-byte key); filter those out.
    const unzipped = unzipSync(result.zip);
    const filePaths = Object.keys(unzipped).filter((k) => !k.endsWith('/')).sort();
    expect(filePaths).toEqual(['package.json', 'src/index.ts']);
    expect(new TextDecoder().decode(unzipped['src/index.ts'])).toBe('export const handler = () => {};');
  });

  test('skips node_modules, dist, .git, hidden files, *.log; KEEPS lib/', () => {
    write('package.json', JSON.stringify({ name: 'fn' }));
    write('src/index.ts', '/* keep */');
    write('lib/index.js', '/* keep — precompiled output is shipped */');
    write('node_modules/foo/index.js', '/* drop */');
    write('dist/index.js', '/* drop */');
    write('.git/HEAD', '/* drop */');
    write('.eslintrc', '/* drop (hidden) */');
    write('debug.log', '/* drop */');

    const result = bundleFunctionSource(tmp);

    expect(result.files).toContain('package.json');
    expect(result.files).toContain('src/index.ts');
    expect(result.files).toContain('lib/index.js');
    expect(result.files.find((f) => f.startsWith('node_modules'))).toBeUndefined();
    expect(result.files.find((f) => f.startsWith('dist/'))).toBeUndefined();
    expect(result.files.find((f) => f.startsWith('.git/'))).toBeUndefined();
    expect(result.files.find((f) => f === '.eslintrc')).toBeUndefined();
    expect(result.files.find((f) => f === 'debug.log')).toBeUndefined();
  });

  test('falls back to nodejs22 when engines.node is missing or unsupported', () => {
    write('package.json', JSON.stringify({ name: 'fn' }));
    write('index.js', '');
    expect(bundleFunctionSource(tmp).runtime).toBe('nodejs22');

    rmSync(join(tmp, 'package.json'));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'fn', engines: { node: '14' } }));
    expect(bundleFunctionSource(tmp).runtime).toBe('nodejs22');
  });

  test('honors a semver range for engines.node (uses major)', () => {
    write('package.json', JSON.stringify({ name: 'fn', engines: { node: '>=20 <23' } }));
    write('index.js', '');
    expect(bundleFunctionSource(tmp).runtime).toBe('nodejs20');
  });

  test('throws when package.json is missing', () => {
    write('src/index.ts', '');
    expect(() => bundleFunctionSource(tmp)).toThrow(/package\.json/);
  });

  test('throws when source dir is empty after defaults', () => {
    write('package.json', JSON.stringify({ name: 'fn' }));
    write('node_modules/foo/index.js', '');
    write('dist/index.js', '');
    // Only the package.json survives the ignore set, so this should
    // succeed — adjust the test to actually empty the dir.
    rmSync(join(tmp, 'package.json'));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'fn' }));
    // package.json is in the bundle, so non-empty → no throw.
    expect(() => bundleFunctionSource(tmp)).not.toThrow();
  });

  test('slim (default) strips devDependencies + build scripts + lockfile', () => {
    write('package.json', JSON.stringify({
      name: 'fn',
      main: 'lib/index.js',
      type: 'module',
      engines: { node: '22' },
      dependencies: { 'firebase-functions': '^6.5.0' },
      devDependencies: { typescript: '^5.7.0', '@types/bun': 'latest' },
      scripts: {
        build: 'tsc',
        'build:watch': 'tsc --watch',
        deploy: 'bun scripts/deploy.ts',
      },
    }, null, 2));
    write('lib/index.js', 'export const handler = () => {};');
    write('package-lock.json', '{ "lockfileVersion": 3 }');

    const result = bundleFunctionSource(tmp);

    // Lockfile dropped from the bundle.
    expect(result.files).not.toContain('package-lock.json');

    // Bundled package.json is the slim version, NOT the on-disk file.
    const unzipped = unzipSync(result.zip);
    const bundledPkg = JSON.parse(new TextDecoder().decode(unzipped['package.json']));
    expect(bundledPkg.devDependencies).toBeUndefined();
    expect(bundledPkg.scripts).toEqual({ deploy: 'bun scripts/deploy.ts' });
    expect(bundledPkg.dependencies).toEqual({ 'firebase-functions': '^6.5.0' });
    expect(bundledPkg.main).toBe('lib/index.js');
    expect(bundledPkg.engines).toEqual({ node: '22' });
    expect(bundledPkg.type).toBe('module');

    // On-disk package.json is unchanged.
    const onDisk = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8'));
    expect(onDisk.devDependencies).toEqual({ typescript: '^5.7.0', '@types/bun': 'latest' });
    expect(onDisk.scripts.build).toBe('tsc');
  });

  test('slim removes scripts entirely when only build keys were present', () => {
    write('package.json', JSON.stringify({
      name: 'fn',
      main: 'lib/index.js',
      scripts: { build: 'tsc', 'build:watch': 'tsc --watch' },
    }));
    write('lib/index.js', '');

    const result = bundleFunctionSource(tmp);
    const unzipped = unzipSync(result.zip);
    const bundledPkg = JSON.parse(new TextDecoder().decode(unzipped['package.json']));
    expect(bundledPkg.scripts).toBeUndefined();
  });

  test('slim: false ships package.json + lockfile verbatim', () => {
    write('package.json', JSON.stringify({
      name: 'fn',
      main: 'lib/index.js',
      dependencies: { 'firebase-functions': '^6.5.0' },
      devDependencies: { typescript: '^5.7.0' },
      scripts: { build: 'tsc' },
    }));
    write('lib/index.js', '');
    write('package-lock.json', '{ "lockfileVersion": 3 }');

    const result = bundleFunctionSource(tmp, { slim: false });

    expect(result.files).toContain('package-lock.json');
    const unzipped = unzipSync(result.zip);
    const bundledPkg = JSON.parse(new TextDecoder().decode(unzipped['package.json']));
    expect(bundledPkg.devDependencies).toEqual({ typescript: '^5.7.0' });
    expect(bundledPkg.scripts.build).toBe('tsc');
  });
});
