#!/usr/bin/env node
// The packed @pyric/live against its release contract
// (scripts/fixtures/live-release-contract.json): the exports and bin it
// ships, the packages it depends on, its peer ranges (firebase is the range
// live mode refuses to start outside), and a file set of dist/ and the
// package files only. The packaging gate runs it on the tarball it is about
// to prove.
//
// Usage: node scripts/lib/check-live-release.mjs <pyric-live-*.tgz> <live-release-contract.json>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PACKAGE_PREFIX = 'package/';

function sameList(actual, expected) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRecord(actual, expected) {
  const keys = Object.keys(expected);
  return sameList(Object.keys(actual ?? {}), keys) && keys.every((key) => actual[key] === expected[key]);
}

/** Every way the packed manifest and file list differ from the contract; empty when they match. */
export function liveReleaseProblems(manifest, files, contract) {
  const problems = [];
  if (manifest.name !== contract.name) problems.push(`name is ${manifest.name}, expected ${contract.name}`);
  if (manifest.private !== undefined) problems.push('the manifest sets "private"');
  if (!sameRecord(manifest.bin, contract.bin)) problems.push(`bin is ${JSON.stringify(manifest.bin)}, expected ${JSON.stringify(contract.bin)}`);
  const exportKeys = Object.keys(manifest.exports ?? {});
  if (!sameList(exportKeys, contract.exports)) problems.push(`exports are ${exportKeys.join(', ')}, expected ${contract.exports.join(', ')}`);
  const dependencyKeys = Object.keys(manifest.dependencies ?? {});
  if (!sameList(dependencyKeys, contract.dependencies)) problems.push(`dependencies are ${dependencyKeys.join(', ')}, expected ${contract.dependencies.join(', ')}`);
  if (!sameRecord(manifest.peerDependencies, contract.peerDependencies)) {
    problems.push(`peerDependencies are ${JSON.stringify(manifest.peerDependencies)}, expected ${JSON.stringify(contract.peerDependencies)}`);
  }
  const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {}).filter(([, meta]) => meta?.optional === true).map(([name]) => name);
  if (!sameList(optionalPeers, contract.optionalPeers)) problems.push(`optional peers are ${optionalPeers.join(', ')}, expected ${contract.optionalPeers.join(', ')}`);
  const packageFiles = new Set(contract.packageFiles);
  for (const file of files) {
    const path = file.startsWith(PACKAGE_PREFIX) ? file.slice(PACKAGE_PREFIX.length) : file;
    const isShipped = path.startsWith('dist/') || packageFiles.has(path);
    if (!isShipped) problems.push(`the tarball ships ${path}, outside dist/ and the package files`);
  }
  return problems;
}

function main() {
  const [tarballArg, contractArg] = process.argv.slice(2);
  if (!tarballArg || !contractArg) {
    console.error('usage: check-live-release.mjs <pyric-live-*.tgz> <live-release-contract.json>');
    process.exit(2);
  }
  const tarball = resolve(tarballArg);
  const contract = JSON.parse(readFileSync(resolve(contractArg), 'utf8'));
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter((line) => line !== '' && !line.endsWith('/'));
  const problems = liveReleaseProblems(manifest, files, contract);
  if (problems.length > 0) {
    console.error(`  ✗ packed ${contract.name} breaks its release contract:`);
    for (const problem of problems) console.error(`    - ${problem}`);
    process.exit(1);
  }
  console.log(`  ✓ packed ${contract.name} matches its release contract: ${contract.exports.length} exports, the pyric-live bin, firebase ${contract.peerDependencies.firebase}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main();
