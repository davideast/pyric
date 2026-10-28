/**
 * #1443: the register confirms that a renamed import such as
 * `firebase-admin-<hash>/app` resolved into the real `firebase-admin` before
 * mapping it. The package's name comes from the `package.json` on disk, not
 * its `exports`, so the check holds for packages that don't export
 * `./package.json` and under a store layout (bun, pnpm) whose links point
 * into `.bun/` or `.pnpm/`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageNameOf } from '../../src/register/package-identity.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));

let root: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeModule(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'export {};\n');
  return pathToFileURL(path).href;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pyric-package-identity-'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('packageNameOf', () => {
  it('names the real firebase-admin for its CommonJS and ESM entry files', () => {
    const cjs = pathToFileURL(requireFromRepo.resolve('firebase-admin/app')).href;
    const esm = import.meta.resolve('firebase-admin/firestore', pathToFileURL(join(repoRoot, 'package.json')).href);
    expect(packageNameOf(cjs)).toBe('firebase-admin');
    expect(packageNameOf(esm)).toBe('firebase-admin');
  });

  it('names the real firebase for a subpath whose own package.json is "firebase/<subpath>"', () => {
    const firestore = import.meta.resolve('firebase/firestore', pathToFileURL(join(repoRoot, 'package.json')).href);
    expect(packageNameOf(firestore)).toBe('firebase');
  });

  it('skips nameless package.json files that only set the module type', () => {
    writeJson(join(root, 'typed/package.json'), { name: 'typed-pkg' });
    writeJson(join(root, 'typed/lib/esm/package.json'), { type: 'module' });
    const url = writeModule(join(root, 'typed/lib/esm/index.js'));
    expect(packageNameOf(url)).toBe('typed-pkg');
  });

  it('names a scoped package by its scope and name', () => {
    writeJson(join(root, 'scoped/package.json'), { name: '@scope/pkg' });
    writeJson(join(root, 'scoped/sub/package.json'), { name: '@scope/pkg/sub' });
    const url = writeModule(join(root, 'scoped/sub/index.js'));
    expect(packageNameOf(url)).toBe('@scope/pkg');
  });

  it('reads the package a link points to, as Turbopack links firebase-admin-<hash>', () => {
    writeJson(join(root, 'store/real-admin/package.json'), { name: 'firebase-admin' });
    writeModule(join(root, 'store/real-admin/lib/app/index.js'));
    writeJson(join(root, 'store/decoy/package.json'), { name: 'decoy' });
    writeModule(join(root, 'store/decoy/index.js'));
    mkdirSync(join(root, 'linked/node_modules'), { recursive: true });
    symlinkSync(join(root, 'store/real-admin'), join(root, 'linked/node_modules/firebase-admin-0123456789abcdef'));
    symlinkSync(join(root, 'store/decoy'), join(root, 'linked/node_modules/firebase-fedcba9876543210'));
    const admin = pathToFileURL(join(root, 'linked/node_modules/firebase-admin-0123456789abcdef/lib/app/index.js')).href;
    const decoy = pathToFileURL(join(root, 'linked/node_modules/firebase-fedcba9876543210/index.js')).href;
    expect(packageNameOf(admin)).toBe('firebase-admin');
    expect(packageNameOf(decoy)).toBe('decoy');
  });

  it('answers null for a URL that is not a file, or a file outside any named package', () => {
    expect(packageNameOf('node:fs')).toBeNull();
    expect(packageNameOf('data:text/javascript,export{}')).toBeNull();
    expect(packageNameOf(pathToFileURL('/no-package-here/index.js').href)).toBeNull();
  });
});
