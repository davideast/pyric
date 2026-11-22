import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from './lib/private-job-tmpdir.ts';
import {
  collectShippedWorkspaceHashes,
  findDriftedPinnedWorkspaceDependencies,
  findUnpublishedWorkspaceDependencies,
  normalizeReleaseTarget,
  npmFetchPublishedTarballHashes,
  npmHasVersion,
  parseCheckPublishArgs,
  readPublishablePackages,
  readWorkspacePackages,
  readWorkspaceVersions,
  tarEntryHashesFromTgz,
  validatePublishableManifests,
  validatePublishVersions,
} from './lib/check-publish-version.mjs';

const root = resolve(import.meta.dir, '..');
// A registry nothing listens on: every lookup fails to connect, at once.
const UNREACHABLE_REGISTRY = { NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/', NPM_CONFIG_FETCH_RETRIES: '0' };

const scratchDirs = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    removePrivateJobTmpDir(dir);
  }
});

function makeScratchDir(prefix) {
  const dir = createPrivateJobTmpDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

describe('publish version validation and --package selector', () => {
  test('parses default pyric and explicit rules selectors cleanly', () => {
    expect(parseCheckPublishArgs(['0.1.0-alpha.9', '/repo'])).toEqual({
      target: 'pyric',
      packedDir: undefined,
      expectedVersion: '0.1.0-alpha.9',
      rootDir: '/repo',
    });
    expect(parseCheckPublishArgs(['--package', 'rules', '0.1.0', '/repo'])).toEqual({
      target: 'rules',
      packedDir: undefined,
      expectedVersion: '0.1.0',
      rootDir: '/repo',
    });
    expect(parseCheckPublishArgs(['--package=@pyric/rules', '--packed=/tmp/pkgs', '0.1.0', '/repo'])).toEqual({
      target: 'rules',
      packedDir: '/tmp/pkgs',
      expectedVersion: '0.1.0',
      rootDir: '/repo',
    });
    expect(normalizeReleaseTarget('other')).toBeNull();
    expect(parseCheckPublishArgs(['--package', 'unknown', '0.1.0']).error).toContain('unknown --package target');
  });

  test('reads @pyric/rules alone when --package rules is selected, and verifies it is not private', () => {
    const rulesPackages = readPublishablePackages(root, 'rules');
    expect(rulesPackages.map((pkg) => pkg.name)).toEqual(['@pyric/rules']);
    expect(validatePublishableManifests(rulesPackages)).toEqual([]);
    expect(validatePublishableManifests([{ name: '@pyric/rules', private: true }])).toEqual([
      '@pyric/rules sets "private": true in package.json',
    ]);
  });

  test('accepts publishable packages at the requested version', () => {
    expect(
      validatePublishVersions('0.1.0-alpha.9', [
        { name: 'pyric', version: '0.1.0-alpha.9' },
        { name: '@pyric/cli', version: '0.1.0-alpha.9' },
      ]),
    ).toEqual([]);
  });

  test('reports every package that does not match the requested version', () => {
    expect(
      validatePublishVersions('0.1.0-alpha.9', [
        { name: 'pyric', version: '0.1.0-alpha.8' },
        { name: 'pyric-admin', version: '0.1.0-alpha.9' },
        { name: '@pyric/cli', version: '0.1.0-alpha.7' },
      ]),
    ).toEqual([
      'pyric is 0.1.0-alpha.8 (expected 0.1.0-alpha.9)',
      '@pyric/cli is 0.1.0-alpha.7 (expected 0.1.0-alpha.9)',
    ]);
  });

  test('passes CLI validation for @pyric/rules at its current manifest version without registry dependency', () => {
    const rulesVersion = JSON.parse(readFileSync(join(root, 'packages/rules/package.json'), 'utf8')).version;
    const run = spawnSync('node', [join(root, 'scripts/lib/check-publish-version.mjs'), '--package', 'rules', rulesVersion, root], {
      encoding: 'utf8',
      env: { ...process.env, ...UNREACHABLE_REGISTRY },
    });
    expect(run.status).toBe(0);
  });
});

describe('workspace dependencies of a publish', () => {
  const versions = { pyric: '0.1.0-alpha.9', '@pyric/cli': '0.1.0-alpha.9', '@pyric/rules': '0.1.0' };
  const pyric = { name: 'pyric', version: '0.1.0-alpha.9', dependencies: { '@pyric/rules': 'workspace:*', zod: '^3.23.0' } };
  const cli = { name: '@pyric/cli', version: '0.1.0-alpha.9', dependencies: { pyric: 'workspace:*' } };

  test('a dependency the same release publishes needs no lookup', () => {
    const asked = [];
    const registryHas = (name, version) => {
      asked.push(`${name}@${version}`);
      return true;
    };
    expect(findUnpublishedWorkspaceDependencies([cli, { ...pyric, dependencies: {} }], versions, registryHas)).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('a dependency outside the release passes when its workspace version is on the registry', () => {
    const asked = [];
    const registryHas = (name, version) => {
      asked.push(`${name}@${version}`);
      return true;
    };
    expect(findUnpublishedWorkspaceDependencies([pyric, cli], versions, registryHas)).toEqual([]);
    expect(asked).toEqual(['@pyric/rules@0.1.0']);
  });

  test('a dependency outside the release that is not on the registry refuses, naming the package, the dependency and the fix', () => {
    expect(findUnpublishedWorkspaceDependencies([pyric, cli], versions, () => false)).toEqual([
      'pyric depends on @pyric/rules (workspace:*), which this release does not publish, and @pyric/rules@0.1.0 is not on the registry. Publish @pyric/rules@0.1.0 first.',
    ]);
  });

  test('a registry that cannot answer refuses too', () => {
    const [refusal] = findUnpublishedWorkspaceDependencies([pyric], versions, () => 'getaddrinfo ENOTFOUND registry.npmjs.org');
    expect(refusal).toContain('@pyric/rules@0.1.0 could not be confirmed on the registry (getaddrinfo ENOTFOUND registry.npmjs.org)');
    expect(refusal).toContain('Publish @pyric/rules@0.1.0 first.');
  });

  test('peer and optional workspace dependencies are checked as well', () => {
    const ui = { name: '@pyric/ui', version: '0.1.0-alpha.9', peerDependencies: { '@pyric/rules': 'workspace:^' }, optionalDependencies: { '@pyric/rules': 'workspace:*' } };
    expect(findUnpublishedWorkspaceDependencies([ui], versions, () => false)).toHaveLength(2);
  });

  test('the repository reads every workspace version, the rules engine included', () => {
    const rules = JSON.parse(readFileSync(join(root, 'packages/rules/package.json'), 'utf8'));
    expect(readWorkspaceVersions(root)['@pyric/rules']).toBe(rules.version);
    expect(readWorkspacePackages(root)['@pyric/rules']?.version).toBe(rules.version);
  });

  test('npm lookups fail closed when the registry is unreachable', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, UNREACHABLE_REGISTRY);
    try {
      const found = npmHasVersion('@pyric/rules', '0.1.0');
      expect(found).not.toBe(true);
      expect(found).not.toBe(false);
      expect(typeof found).toBe('string');

      const fetched = await npmFetchPublishedTarballHashes('@pyric/rules', '0.1.0');
      expect(fetched instanceof Map).toBe(false);
      expect(typeof fetched).toBe('string');
    } finally {
      for (const name of Object.keys(UNREACHABLE_REGISTRY)) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test('the check refuses this repository while @pyric/rules cannot be confirmed on the registry', () => {
    const version = JSON.parse(readFileSync(join(root, 'packages/pyric/package.json'), 'utf8')).version;
    const run = spawnSync('node', [join(root, 'scripts/lib/check-publish-version.mjs'), version, root], {
      encoding: 'utf8',
      env: { ...process.env, ...UNREACHABLE_REGISTRY },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('pyric depends on @pyric/rules (workspace:*)');
    expect(run.stderr).toContain('Publish @pyric/rules@');
  });
});

describe('forgotten @pyric/rules bump guard (#1521)', () => {
  function createRulesFixtureRepo() {
    const repo = makeScratchDir('pyric-rules-drift-');
    const rulesDir = join(repo, 'packages/rules');
    const pyricDir = join(repo, 'packages/pyric');
    mkdirSync(join(rulesDir, 'src'), { recursive: true });
    mkdirSync(join(rulesDir, 'dist'), { recursive: true });
    mkdirSync(join(rulesDir, 'test'), { recursive: true });
    mkdirSync(pyricDir, { recursive: true });

    const rulesManifest = {
      name: '@pyric/rules',
      version: '0.1.0',
      type: 'module',
      files: ['dist', 'src', 'README.md', 'LICENSE'],
    };
    const pyricManifest = {
      name: 'pyric',
      version: '0.1.0-alpha.36',
      dependencies: { '@pyric/rules': 'workspace:*' },
    };
    writeFileSync(join(rulesDir, 'package.json'), `${JSON.stringify(rulesManifest, null, 2)}\n`);
    writeFileSync(join(rulesDir, 'README.md'), '# @pyric/rules\n');
    writeFileSync(join(rulesDir, 'LICENSE'), 'Apache-2.0\n');
    writeFileSync(join(rulesDir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n');
    writeFileSync(join(rulesDir, 'src/index.ts'), 'export const version = 1;\n');
    writeFileSync(join(rulesDir, 'dist/index.js'), 'export const version = 1;\n');
    writeFileSync(join(rulesDir, 'test/index.test.ts'), 'export {};\n');
    writeFileSync(join(pyricDir, 'package.json'), `${JSON.stringify(pyricManifest, null, 2)}\n`);

    const packOut = makeScratchDir('pyric-rules-packed-');
    const packRun = spawnSync('npm', ['pack', '--silent', '--pack-destination', packOut], {
      cwd: rulesDir,
      encoding: 'utf8',
    });
    expect(packRun.status).toBe(0);
    const publishedTgz = readFileSync(join(packOut, packRun.stdout.trim()));
    const publishedHashes = tarEntryHashesFromTgz(publishedTgz);
    return { repo, rulesDir, packOut, pyricManifest, publishedHashes };
  }

  test('passes when workspace @pyric/rules matches the published tarball, even if CHANGELOG or tests change', async () => {
    const { repo, rulesDir, pyricManifest, publishedHashes } = createRulesFixtureRepo();
    writeFileSync(join(rulesDir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.1 (draft)\n');
    writeFileSync(join(rulesDir, 'test/index.test.ts'), 'export const extraTest = true;\n');

    const refusals = await findDriftedPinnedWorkspaceDependencies(
      [pyricManifest],
      readWorkspacePackages(repo),
      async () => publishedHashes,
    );
    expect(refusals).toEqual([]);
  });

  test('refuses clearly when shipped @pyric/rules source, README, or added/removed files differ without a version bump', async () => {
    const { repo, rulesDir, pyricManifest, publishedHashes } = createRulesFixtureRepo();
    writeFileSync(join(rulesDir, 'src/index.ts'), 'export const version = 2;\n');
    writeFileSync(join(rulesDir, 'src/extra.ts'), 'export const extra = true;\n');

    const refusals = await findDriftedPinnedWorkspaceDependencies(
      [pyricManifest],
      readWorkspacePackages(repo),
      async () => publishedHashes,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('@pyric/rules@0.1.0 is immutable on npm and pyric pins it exactly');
    expect(refusals[0]).toContain('src/extra.ts (added locally)');
    expect(refusals[0]).toContain('src/index.ts (modified)');
    expect(refusals[0]).toContain('bash scripts/prepare-release.sh --package rules <next-version>');
  });

  test('catches dist-only drift when --packed compares the freshly packed tarball', async () => {
    const { repo, rulesDir, packOut, pyricManifest, publishedHashes } = createRulesFixtureRepo();
    writeFileSync(join(rulesDir, 'dist/index.js'), 'export const version = 999;\n');
    const repack = spawnSync('npm', ['pack', '--silent', '--pack-destination', packOut], {
      cwd: rulesDir,
      encoding: 'utf8',
    });
    expect(repack.status).toBe(0);

    const refusals = await findDriftedPinnedWorkspaceDependencies(
      [pyricManifest],
      readWorkspacePackages(repo),
      async () => publishedHashes,
      { packedDir: packOut },
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('dist/index.js (modified)');
  });

  test('workspace hash collection on the real packages/rules matches npm pack source entries byte-for-byte', () => {
    const packOut = makeScratchDir('pyric-real-rules-pack-');
    const rulesDir = join(root, 'packages/rules');
    const rulesManifest = JSON.parse(readFileSync(join(rulesDir, 'package.json'), 'utf8'));
    const packRun = spawnSync('npm', ['pack', '--silent', '--pack-destination', packOut], {
      cwd: rulesDir,
      encoding: 'utf8',
    });
    expect(packRun.status).toBe(0);
    const packedHashes = tarEntryHashesFromTgz(readFileSync(join(packOut, packRun.stdout.trim())));
    const packedNonDist = new Map(
      [...packedHashes.entries()].filter(([path]) => path !== 'dist' && !path.startsWith('dist/')),
    );
    const workspaceHashes = collectShippedWorkspaceHashes(rulesDir, rulesManifest);
    expect(workspaceHashes).toEqual(packedNonDist);
  }, 20_000);
});
