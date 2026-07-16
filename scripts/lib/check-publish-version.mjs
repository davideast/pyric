#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLISHABLE_PACKAGE_DIRS = [
  'packages/pyric',
  'packages/pyric-admin',
  'packages/create-pyric',
  'packages/cli',
  'packages/ui',
];

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

function main() {
  const expectedVersion = process.argv[2];
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const rootDir = resolve(process.argv[3] ?? defaultRoot);

  if (!expectedVersion) {
    console.error('usage: check-publish-version.mjs <version> [repo-root]');
    process.exit(2);
  }

  const mismatches = validatePublishVersions(
    expectedVersion,
    readPublishablePackages(rootDir),
  );

  if (mismatches.length > 0) {
    console.error(`✗ Refusing to publish ${expectedVersion}: package versions are not in lockstep:`);
    for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
    console.error('');
    console.error('Bump all five package.json versions and refresh bun.lock before publishing.');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
