#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLISHABLE_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
  'packages/live',
];

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

export function validatePublishVersions(expectedVersion, packages) {
  return packages
    .filter(({ version }) => version !== expectedVersion)
    .map(
      ({ name, version }) =>
        `${name} is ${version} (expected ${expectedVersion})`,
    );
}

export function readPublishablePackages(rootDir) {
  return PUBLISHABLE_PACKAGE_DIRS.map((packageDir) =>
    JSON.parse(readFileSync(join(rootDir, packageDir, 'package.json'), 'utf8')),
  );
}

/** Every workspace package's version, by name. */
export function readWorkspaceVersions(rootDir) {
  const versions = {};
  for (const entry of readdirSync(join(rootDir, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(rootDir, 'packages', entry.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name && manifest.version) versions[manifest.name] = manifest.version;
  }
  return versions;
}

/**
 * A published package that depends on a workspace package through `workspace:`
 * gets that package's version in its packed manifest. When the dependency is
 * neither in this publish nor on the registry, the release would install for
 * nobody. `registryHas(name, version)` answers true, false, or a string
 * naming why the registry could not answer; anything but true refuses.
 */
export function findUnpublishedWorkspaceDependencies(packages, workspaceVersions, registryHas) {
  const publishing = new Set(packages.map(({ name }) => name));
  const refusals = [];
  for (const manifest of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
        if (publishing.has(dependency)) continue;
        const version = workspaceVersions[dependency];
        if (!version) {
          refusals.push(`${manifest.name} depends on ${dependency} (${spec}), which is not a workspace package`);
          continue;
        }
        const found = registryHas(dependency, version);
        if (found === true) continue;
        const why = found === false ? 'is not on the registry' : `could not be confirmed on the registry (${found})`;
        refusals.push(
          `${manifest.name} depends on ${dependency} (${spec}), which this release does not publish, and ${dependency}@${version} ${why}. ` +
            `Publish ${dependency}@${version} first.`,
        );
      }
    }
  }
  return refusals;
}

/** Whether `name@version` is on the registry npm is configured for. */
export function npmHasVersion(name, version) {
  const run = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', env: process.env });
  const output = `${run.stderr ?? ''}\n${run.stdout ?? ''}`;
  if (run.status === 0) return (run.stdout ?? '').trim() === version;
  if (/\bE404\b/.test(output)) return false;
  if (run.error) return run.error.message;
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[0] ?? `npm view exited ${run.status}`;
}

function main() {
  const expectedVersion = process.argv[2];
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const rootDir = resolve(process.argv[3] ?? defaultRoot);

  if (!expectedVersion) {
    console.error('usage: check-publish-version.mjs <version> [repo-root]');
    process.exit(2);
  }

  const packages = readPublishablePackages(rootDir);
  const mismatches = validatePublishVersions(expectedVersion, packages);

  if (mismatches.length > 0) {
    console.error(`✗ Refusing to publish ${expectedVersion}: package versions are not in lockstep:`);
    for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
    console.error('');
    console.error('Bump every published package.json version and refresh bun.lock before publishing.');
    process.exit(1);
  }

  const unpublished = findUnpublishedWorkspaceDependencies(packages, readWorkspaceVersions(rootDir), npmHasVersion);
  if (unpublished.length > 0) {
    console.error(`✗ Refusing to publish ${expectedVersion}: a published package depends on a workspace package that is not on the registry:`);
    for (const refusal of unpublished) console.error(`  - ${refusal}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
