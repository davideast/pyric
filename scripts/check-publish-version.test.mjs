import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  findUnpublishedWorkspaceDependencies,
  npmHasVersion,
  readWorkspaceVersions,
  validatePublishVersions,
} from './lib/check-publish-version.mjs';

const root = resolve(import.meta.dir, '..');
// A registry nothing listens on: every lookup fails to connect, at once.
const UNREACHABLE_REGISTRY = { NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/', NPM_CONFIG_FETCH_RETRIES: '0' };

describe('publish version validation', () => {
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
  });

  test('npm lookups fail closed when the registry is unreachable', () => {
    const saved = { ...process.env };
    Object.assign(process.env, UNREACHABLE_REGISTRY);
    try {
      const found = npmHasVersion('@pyric/rules', '0.1.0');
      expect(found).not.toBe(true);
      expect(found).not.toBe(false);
      expect(typeof found).toBe('string');
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
