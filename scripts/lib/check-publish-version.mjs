#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const PYRIC_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
  'packages/live',
];

const RULES_PACKAGE_DIR = 'packages/rules';
const PINNED_WORKSPACE_PACKAGES = new Set(['@pyric/rules']);
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const TAR_BLOCK = 512;
const REGULAR_TAR_TYPES = new Set(['0', '\0', '7']);
const LONG_NAME_TAR_TYPES = new Set(['x', 'L']);
const MAX_LISTED_DIFFS = 5;

export function normalizeReleaseTarget(raw) {
  if (raw === undefined || raw === 'pyric') return 'pyric';
  if (raw === 'rules' || raw === '@pyric/rules') return 'rules';
  return null;
}

export function parseCheckPublishArgs(argv) {
  let target = 'pyric';
  let packedDir;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package') {
      const value = argv[index + 1];
      if (!value) return { error: '--package requires a target (pyric or rules)' };
      const normalized = normalizeReleaseTarget(value);
      if (!normalized) return { error: `unknown --package target "${value}" (expected pyric or rules)` };
      target = normalized;
      index += 1;
      continue;
    }
    if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length);
      const normalized = normalizeReleaseTarget(value);
      if (!normalized) return { error: `unknown --package target "${value}" (expected pyric or rules)` };
      target = normalized;
      continue;
    }
    if (arg === '--packed') {
      const value = argv[index + 1];
      if (!value) return { error: '--packed requires a directory path' };
      packedDir = resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--packed=')) {
      const value = arg.slice('--packed='.length);
      if (!value) return { error: '--packed requires a directory path' };
      packedDir = resolve(value);
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `unknown flag "${arg}"` };
    }
    positional.push(arg);
  }

  const expectedVersion = positional[0];
  if (!expectedVersion) {
    return {
      error: 'usage: check-publish-version.mjs [--package pyric|rules] [--packed <dir>] <version> [repo-root]',
    };
  }
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const rootDir = resolve(positional[1] ?? defaultRoot);
  return { target, packedDir, expectedVersion, rootDir };
}

export function validatePublishableManifests(packages) {
  return packages
    .filter((manifest) => manifest.private === true)
    .map(({ name }) => `${name} sets "private": true in package.json`);
}

export function validatePublishVersions(expectedVersion, packages) {
  return packages
    .filter(({ version }) => version !== expectedVersion)
    .map(({ name, version }) => `${name} is ${version} (expected ${expectedVersion})`);
}

export function readPublishablePackages(rootDir, target = 'pyric') {
  const dirs = target === 'rules' ? [RULES_PACKAGE_DIR] : PYRIC_PACKAGE_DIRS;
  return dirs.map((packageDir) =>
    JSON.parse(readFileSync(join(rootDir, packageDir, 'package.json'), 'utf8')),
  );
}

/** Every workspace package's manifest and directory, keyed by package name. */
export function readWorkspacePackages(rootDir) {
  const packages = {};
  const packagesRoot = join(rootDir, 'packages');
  if (!existsSync(packagesRoot)) return packages;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name && manifest.version) {
      packages[manifest.name] = { version: manifest.version, dir, manifest };
    }
  }
  return packages;
}

/** Every workspace package's version, by name. */
export function readWorkspaceVersions(rootDir) {
  const entries = readWorkspacePackages(rootDir);
  const versions = {};
  for (const [name, info] of Object.entries(entries)) {
    versions[name] = info.version;
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

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseOctalSize(rawSize) {
  if (rawSize === '') return 0;
  return Number.parseInt(rawSize, 8);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function tarHeaderField(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  const stop = end === -1 ? length : end;
  return field.subarray(0, stop).toString('utf8');
}

function paxPath(body) {
  const record = body.toString('utf8').split('\n').find((line) => /^\d+ path=/.test(line));
  if (!record) return undefined;
  return record.slice(record.indexOf('=') + 1);
}

function underPackagePrefix(rawPath) {
  const normalized = rawPath.replace(/^(?:\.\/)+/, '');
  const slash = normalized.indexOf('/');
  if (slash === -1) return undefined;
  const rest = normalized.slice(slash + 1);
  if (rest === '') return undefined;
  return rest;
}

export function tarEntryHashesFromTgz(tgzBytes) {
  const tar = gunzipSync(tgzBytes);
  const hashes = new Map();
  let offset = 0;
  let nextName;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    const name = tarHeaderField(header, 0, 100);
    if (name === '') break;
    const prefix = tarHeaderField(header, 345, 155);
    const type = tarHeaderField(header, 156, 1) || '\0';
    const rawSize = tarHeaderField(header, 124, 12).trim();
    const size = parseOctalSize(rawSize);
    if (!Number.isInteger(size) || size < 0 || offset + TAR_BLOCK + size > tar.length) {
      throw new Error('corrupt or truncated tar entry header');
    }
    const body = tar.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK + size);
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (LONG_NAME_TAR_TYPES.has(type)) {
      if (type === 'x') {
        const parsedPath = paxPath(body);
        if (parsedPath !== undefined) nextName = parsedPath;
      } else {
        nextName = tarHeaderField(body, 0, body.length);
      }
      continue;
    }
    let fullName = name;
    if (nextName !== undefined) {
      fullName = nextName;
    } else if (prefix !== '') {
      fullName = `${prefix}/${name}`;
    }
    nextName = undefined;
    const relPath = underPackagePrefix(fullName);
    if (REGULAR_TAR_TYPES.has(type) && relPath !== undefined) {
      hashes.set(relPath, sha256Hex(body));
    }
  }
  return hashes;
}

function collectWorkspacePath(baseDir, relEntry, out) {
  const full = join(baseDir, relEntry);
  if (!existsSync(full)) return;
  const stats = statSync(full);
  if (stats.isFile()) {
    out.set(relEntry, sha256Hex(readFileSync(full)));
    return;
  }
  if (!stats.isDirectory()) return;
  for (const item of readdirSync(full, { withFileTypes: true })) {
    if (item.name === '.DS_Store' || item.name.startsWith('._')) continue;
    const childRel = posix.join(relEntry, item.name);
    if (item.isDirectory()) {
      collectWorkspacePath(baseDir, childRel, out);
    } else if (item.isFile()) {
      out.set(childRel, sha256Hex(readFileSync(join(baseDir, childRel))));
    }
  }
}

export function collectShippedWorkspaceHashes(packageDir, manifest) {
  const hashes = new Map();
  collectWorkspacePath(packageDir, 'package.json', hashes);
  for (const rawEntry of manifest.files ?? []) {
    const cleaned = String(rawEntry).replace(/^\.\//, '').replace(/\/+$/, '');
    if (cleaned === '' || cleaned === 'dist' || cleaned.startsWith('dist/')) continue;
    collectWorkspacePath(packageDir, cleaned, hashes);
  }
  return hashes;
}

function diffHashMaps(localHashes, publishedHashes) {
  const diffs = [];
  const allPaths = new Set([...localHashes.keys(), ...publishedHashes.keys()]);
  for (const path of [...allPaths].sort()) {
    const local = localHashes.get(path);
    const published = publishedHashes.get(path);
    if (local !== undefined && published === undefined) {
      diffs.push(`${path} (added locally)`);
    } else if (local === undefined && published !== undefined) {
      diffs.push(`${path} (removed locally)`);
    } else if (local !== published) {
      diffs.push(`${path} (modified)`);
    }
  }
  return diffs;
}

function summarizeDiffs(diffs) {
  if (diffs.length <= MAX_LISTED_DIFFS) return diffs.join(', ');
  return `${diffs.slice(0, MAX_LISTED_DIFFS).join(', ')}, and ${diffs.length - MAX_LISTED_DIFFS} more`;
}

export async function npmFetchPublishedTarballHashes(name, version) {
  const view = spawnSync('npm', ['view', `${name}@${version}`, 'dist', '--json'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (view.status !== 0) {
    if (view.error) return view.error.message;
    const lines = `${view.stderr ?? ''}\n${view.stdout ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines[0] ?? `npm view dist exited ${view.status}`;
  }
  let dist;
  try {
    dist = JSON.parse(view.stdout ?? '{}');
  } catch {
    return 'npm view dist did not print JSON';
  }
  if (!dist || typeof dist.tarball !== 'string' || dist.tarball === '') {
    return 'npm view dist returned no tarball URL';
  }
  let response;
  try {
    response = await fetch(dist.tarball, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return describeError(error);
  }
  if (!response.ok) {
    return `HTTP ${response.status} fetching ${dist.tarball}`;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')) {
    const computed = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (computed !== dist.integrity) {
      return `tarball integrity mismatch for ${name}@${version}`;
    }
  }
  try {
    return tarEntryHashesFromTgz(bytes);
  } catch (error) {
    return `failed to unpack ${name}@${version} tarball (${describeError(error)})`;
  }
}

export async function findDriftedPinnedWorkspaceDependencies(
  packages,
  workspacePackages,
  fetchPublishedHashes,
  options = {},
) {
  const publishing = new Set(packages.map(({ name }) => name));
  const checked = new Set();
  const refusals = [];

  for (const consumer of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(consumer[field] ?? {})) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
        if (publishing.has(dependency)) continue;
        if (!PINNED_WORKSPACE_PACKAGES.has(dependency)) continue;
        if (checked.has(dependency)) continue;
        checked.add(dependency);

        const target = workspacePackages[dependency];
        if (!target) continue;
        const { version, dir: targetDir, manifest: targetManifest } = target;
        const published = await fetchPublishedHashes(dependency, version);
        if (!(published instanceof Map)) {
          refusals.push(
            `${dependency}@${version} could not be fetched from the registry to verify pinned package contents (${published}).`,
          );
          continue;
        }

        let localHashes;
        let publishedComparable;
        if (options.packedDir) {
          const fileName = `${dependency.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
          const packedFile = join(options.packedDir, fileName);
          if (!existsSync(packedFile)) {
            refusals.push(`expected packed tarball ${packedFile} to verify ${dependency}@${version} contents`);
            continue;
          }
          localHashes = tarEntryHashesFromTgz(readFileSync(packedFile));
          publishedComparable = published;
        } else {
          localHashes = collectShippedWorkspaceHashes(targetDir, targetManifest);
          publishedComparable = new Map(
            [...published.entries()].filter(([path]) => path !== 'dist' && !path.startsWith('dist/')),
          );
        }

        const diffs = diffHashMaps(localHashes, publishedComparable);
        if (diffs.length > 0) {
          refusals.push(
            `${dependency}@${version} is immutable on npm and ${consumer.name} pins it exactly, ` +
              `but workspace ${dependency} differs in ${diffs.length} shipped file(s): ${summarizeDiffs(diffs)}. ` +
              `Bump packages/rules/package.json (bash scripts/prepare-release.sh --package rules <next-version>) ` +
              `and publish ${dependency}@<next-version> before cutting this release.`,
          );
        }
      }
    }
  }

  return refusals;
}

async function main() {
  const parsed = parseCheckPublishArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  const { target, packedDir, expectedVersion, rootDir } = parsed;

  const packages = readPublishablePackages(rootDir, target);
  const privateProblems = validatePublishableManifests(packages);
  if (privateProblems.length > 0) {
    console.error(`x Refusing to publish ${expectedVersion}: publishable manifest is marked private:`);
    for (const problem of privateProblems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const mismatches = validatePublishVersions(expectedVersion, packages);
  if (mismatches.length > 0) {
    if (target === 'rules') {
      console.error(`x Refusing to publish @pyric/rules@${expectedVersion}: manifest version does not match:`);
      for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
      console.error('');
      console.error('Bump packages/rules/package.json and refresh bun.lock before publishing.');
    } else {
      console.error(`x Refusing to publish ${expectedVersion}: package versions are not in lockstep:`);
      for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
      console.error('');
      console.error('Bump every published package.json version and refresh bun.lock before publishing.');
    }
    process.exit(1);
  }

  const workspacePackages = readWorkspacePackages(rootDir);
  const workspaceVersions = {};
  for (const [name, info] of Object.entries(workspacePackages)) {
    workspaceVersions[name] = info.version;
  }

  const unpublished = findUnpublishedWorkspaceDependencies(packages, workspaceVersions, npmHasVersion);
  if (unpublished.length > 0) {
    console.error(`x Refusing to publish ${expectedVersion}: a published package depends on a workspace package that is not on the registry:`);
    for (const refusal of unpublished) console.error(`  - ${refusal}`);
    process.exit(1);
  }

  const drifted = await findDriftedPinnedWorkspaceDependencies(
    packages,
    workspacePackages,
    npmFetchPublishedTarballHashes,
    { packedDir },
  );
  if (drifted.length > 0) {
    console.error(`x Refusing to publish ${expectedVersion}: pinned workspace package contents differ from the published registry version:`);
    for (const refusal of drifted) console.error(`  - ${refusal}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
