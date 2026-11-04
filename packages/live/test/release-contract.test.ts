/**
 * `@pyric/live`'s release contract (`scripts/fixtures/live-release-contract.json`):
 * the manifest it publishes from, and the check the packaging gate runs on
 * its tarball (`scripts/lib/check-live-release.mjs`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_FIREBASE_RANGE } from '../src/start-checks.js';

interface LiveReleaseContract {
  schema: 'pyric.live.release-contract.v1';
  name: string;
  bin: Record<string, string>;
  exports: string[];
  dependencies: string[];
  peerDependencies: Record<string, string>;
  optionalPeers: string[];
  packageFiles: string[];
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  publishConfig?: { access?: string };
}

type LiveReleaseProblems = (manifest: Manifest, files: string[], contract: LiveReleaseContract) => string[];

const repoRoot = join(import.meta.dir, '../../..');
const contract = JSON.parse(readFileSync(join(repoRoot, 'scripts/fixtures/live-release-contract.json'), 'utf8')) as LiveReleaseContract;
const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as Manifest;
const cliManifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')) as Manifest;
const checkerPath = join(repoRoot, 'scripts/lib/check-live-release.mjs');

async function liveReleaseProblems(): Promise<LiveReleaseProblems> {
  const checker = (await import(checkerPath)) as { liveReleaseProblems: LiveReleaseProblems };
  return checker.liveReleaseProblems;
}

const PACKED_FILES = ['package/package.json', 'package/LICENSE', 'package/README.md', 'package/dist/index.js', 'package/dist/cli.js'];

describe('@pyric/live publishes', () => {
  test('as a public package, versioned in lockstep with @pyric/cli', () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.version).toBe(cliManifest.version);
  });

  test('the exports, bin and peers its release contract names', async () => {
    expect(contract.name).toBe(manifest.name);
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([...contract.exports].sort());
    expect(manifest.bin).toEqual(contract.bin);
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...contract.dependencies].sort());
    expect(manifest.peerDependencies).toEqual(contract.peerDependencies);
    const check = await liveReleaseProblems();
    expect(check({ ...manifest, dependencies: { '@pyric/cli': '^0.1.0-alpha.33' } }, PACKED_FILES, contract)).toEqual([]);
  });

  test('with @pyric/cli as a workspace dependency, which the pack rewrites to a caret range', () => {
    expect(manifest.dependencies?.['@pyric/cli']).toBe('workspace:*');
  });

  test('with firebase as a peer in the range the start check refuses outside', () => {
    expect(manifest.peerDependencies?.firebase).toBe(SUPPORTED_FIREBASE_RANGE);
    expect(contract.peerDependencies.firebase).toBe(SUPPORTED_FIREBASE_RANGE);
    expect(manifest.dependencies?.firebase).toBeUndefined();
  });

  test('dist/ and the package files only', () => {
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});

describe('the packed release check', () => {
  test('names a tarball that ships source, tests or a private flag', async () => {
    const check = await liveReleaseProblems();
    const problems = check({ ...manifest, private: true }, [...PACKED_FILES, 'package/src/cli.ts', 'package/test/observe.test.ts'], contract);
    expect(problems).toEqual([
      'the manifest sets "private"',
      'the tarball ships src/cli.ts, outside dist/ and the package files',
      'the tarball ships test/observe.test.ts, outside dist/ and the package files',
    ]);
  });

  test('names a firebase peer range other than the supported one, and a dropped export', async () => {
    const check = await liveReleaseProblems();
    const exports = { ...manifest.exports };
    delete exports['./register'];
    const problems = check({ ...manifest, exports, peerDependencies: { ...manifest.peerDependencies, firebase: '>=12' } }, PACKED_FILES, contract);
    expect(problems.some((problem) => problem.startsWith('exports are '))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('peerDependencies are '))).toBe(true);
  });
});
