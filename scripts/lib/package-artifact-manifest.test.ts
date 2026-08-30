import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertPackageArtifactHygiene,
  createPackageArtifactManifest,
} from './package-artifact-manifest.mjs';

const workDirs: string[] = [];

afterEach(() => {
  for (const directory of workDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('package artifact manifest', () => {
  test('reports exports from the packed manifest, not the source manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-artifact-manifest-'));
    workDirs.push(root);
    const packageDir = join(root, 'packages/example');
    const packedDir = join(root, 'packed/package');
    const outDir = join(root, 'dist/packages');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(packedDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@example/pkg',
        version: '1.2.3',
        exports: { './public': './dist/public.js', './removed': './dist/removed.js' },
      }),
    );
    writeFileSync(
      join(packedDir, 'package.json'),
      JSON.stringify({
        name: '@example/pkg',
        version: '1.2.3',
        exports: { './public': './dist/public.js' },
      }),
    );

    const tarball = join(outDir, 'example-pkg-1.2.3.tgz');
    const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'packed'), 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(packed.status).toBe(0);

    const manifest = createPackageArtifactManifest({
      root,
      outDir,
      packageDirs: ['packages/example'],
      generatedAt: '2026-07-19T00:00:00.000Z',
    });

    expect(manifest.packages[0]?.subpaths).toEqual(['./public']);
    const sourceExports = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    ).exports;
    expect(Object.keys(sourceExports)).toContain('./removed');
  });

  test('rejects macOS metadata and temporary README files', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-artifact-hygiene-'));
    workDirs.push(root);
    const packedDir = join(root, 'packed/package');
    mkdirSync(packedDir, { recursive: true });
    writeFileSync(join(packedDir, 'package.json'), '{}');
    writeFileSync(join(packedDir, '._package.json'), 'metadata');
    writeFileSync(join(packedDir, 'README.md.orig'), 'temporary readme');

    const tarball = join(root, 'package.tgz');
    const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'packed'), 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(packed.status).toBe(0);

    expect(() => assertPackageArtifactHygiene(tarball)).toThrow('package/._package.json');
    expect(() => assertPackageArtifactHygiene(tarball)).toThrow('package/README.md.orig');
  });
});
