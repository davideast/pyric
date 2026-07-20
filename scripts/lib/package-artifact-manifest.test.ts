import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPackageArtifactManifest } from './package-artifact-manifest.mjs';

describe('package artifact manifest', () => {
  test('reports exports from the packed manifest, not the source manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-artifact-manifest-'));
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
    const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'packed'), 'package']);
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
});
