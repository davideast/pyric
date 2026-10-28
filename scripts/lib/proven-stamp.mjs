#!/usr/bin/env node
// The record that a set of packed tarballs passed every pre-publish gate.
//
//   node scripts/lib/proven-stamp.mjs record <packages dir> <repo root> <head> <clean>
//   node scripts/lib/proven-stamp.mjs write  <packages dir> <version> <repo root> <name>...
//   node scripts/lib/proven-stamp.mjs verify <packages dir> <version> <repo root> <name>...
//   node scripts/lib/proven-stamp.mjs check  <packages dir> <repo root>
//
// `record` runs at the end of scripts/pack-packages.sh. It adds the pack's
// own facts to manifest.json: each tarball's sha256 as the pack wrote it,
// and the commit and clean state of the tree it packed (taken before the
// build).
//
// `write` runs in publish-alpha.sh once every gate has passed. It refuses
// unless the tarballs on disk are still the bytes the pack wrote, and HEAD
// and the clean state are still the pack's, so a concurrent pack or app run
// that swapped a file during the gates cannot get its bytes stamped. The
// stamp, proven.json, records the pack-time values.
//
// `verify` runs before any upload: on a gate-skipping rerun
// (PYRIC_PUBLISH_SKIP_GATES=1) against dist/packages, and on every run
// against the copies the publish uploads. It requires exactly the named
// tarballs (`<name>-<version>.tgz`, the files the publish loop uploads),
// each matching the stamp, the stamp's commit at HEAD, and a clean tree then
// and now. Anything else is refused, so only bytes that passed are uploaded.
//
// `check` runs in every CI job that takes the tarballs from the one pack
// another job made and uploaded. It requires the tarballs in the directory to
// be exactly the ones manifest.json's pack record lists, each with the hash
// the pack wrote, so a job tests the bytes that pack made and no others. It
// also requires the pack to come from the commit this job checked out
// (GITHUB_SHA when set, otherwise HEAD), so a job never tests another
// commit's tarballs. It does not ask for a clean tree: the job checking is not
// the job that packed, and its own install and downloads touch the tree.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STAMP = 'proven.json';
const MANIFEST = 'manifest.json';

function headOf(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** Clean whatever the user's git config says about untracked files or submodules. */
function isClean(root) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], { cwd: root, encoding: 'utf8' });
  return status.trim() === '';
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path, what) {
  if (!existsSync(path)) return { missing: `no ${what} in ${path.slice(0, path.lastIndexOf('/'))}` };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { missing: `${what} is not valid JSON: ${error.message}` };
  }
}

const PUBLISH_HINT = 'Run the publish again without PYRIC_PUBLISH_SKIP_GATES so the gates prove a fresh pack.';

function fail(action, dir, found, hint = PUBLISH_HINT) {
  console.error(`proven-stamp: ${action} refused for ${dir}:\n${found.map((line) => `  - ${line}`).join('\n')}\n${hint}`);
  process.exit(1);
}

function record(dir, root, head, clean) {
  const manifestPath = join(dir, MANIFEST);
  const manifest = readJson(manifestPath, MANIFEST);
  if (manifest.missing) fail('record', dir, [manifest.missing]);
  const tarballs = Object.fromEntries(readdirSync(dir).filter((file) => file.endsWith('.tgz')).sort().map((file) => [file, sha256Of(join(dir, file))]));
  manifest.value.pack = { head, clean: clean === 'true', tarballs };
  writeFileSync(manifestPath, `${JSON.stringify(manifest.value, null, 2)}\n`);
  console.log(`proven-stamp: recorded ${Object.keys(tarballs).length} tarballs packed from ${head}${clean === 'true' ? '' : ' (tree not clean)'}`);
}

/** The tree the facts name must be the tree here, clean then and now. */
function treeProblems(facts, root) {
  const found = [];
  const head = headOf(root);
  if (facts.head !== head) found.push(`the tarballs were packed from commit ${facts.head}, and HEAD is ${head}`);
  if (facts.clean !== true) found.push('the tree had uncommitted or untracked changes when the tarballs were packed');
  if (!isClean(root)) found.push('the tree has uncommitted or untracked changes now');
  return found;
}

/** Every named tarball must be on disk with exactly the hash `expected` lists for it, and `expected` must list no other. */
function tarballProblems(dir, files, expected, against) {
  const found = [];
  const listed = Object.keys(expected ?? {}).sort();
  const isExactSet = listed.length === files.length && listed.every((file, index) => file === [...files].sort()[index]);
  if (!isExactSet) found.push(`${against} lists ${listed.join(', ') || 'no tarballs'}, not exactly ${files.join(', ')}`);
  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) found.push(`${file} is missing`);
    else if (sha256Of(path) !== expected?.[file]) found.push(`${file} is not the file ${against} names`);
  }
  return found;
}

function write(dir, version, root, files) {
  const manifest = readJson(join(dir, MANIFEST), MANIFEST);
  if (manifest.missing) fail('stamping', dir, [manifest.missing]);
  const pack = manifest.value.pack;
  if (!pack) fail('stamping', dir, [`${MANIFEST} has no pack record: pack with scripts/pack-packages.sh`]);
  const packed = Object.fromEntries(files.map((file) => [file, pack.tarballs?.[file]]).filter(([, hash]) => hash !== undefined));
  const found = [...treeProblems(pack, root), ...tarballProblems(dir, files, packed, 'the pack')];
  if (files.some((file) => pack.tarballs?.[file] === undefined)) found.push(`the pack did not write ${files.filter((file) => pack.tarballs?.[file] === undefined).join(', ')}`);
  if (found.length > 0) fail('stamping', dir, found);
  const stamp = { head: pack.head, clean: pack.clean, version, tarballs: packed };
  writeFileSync(join(dir, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`proven-stamp: ${files.length} tarballs proven, packed from ${stamp.head}`);
}

function verify(dir, version, root, files) {
  const stamp = readJson(join(dir, STAMP), STAMP);
  if (stamp.missing) fail('upload', dir, [`${stamp.missing}: no gate run proved these tarballs`]);
  const found = [];
  if (stamp.value.version !== version) found.push(`the tarballs were proven for ${stamp.value.version}, not ${version}`);
  found.push(...treeProblems(stamp.value, root), ...tarballProblems(dir, files, stamp.value.tarballs, 'the stamp'));
  if (found.length > 0) fail('upload', dir, found);
  console.log(`proven-stamp: the ${files.length} tarballs in ${dir} are the ones proven on ${stamp.value.head}`);
}

/** The commit this job tests: the one CI checked out, or HEAD outside CI. */
function checkedOutCommit(root) {
  return process.env.GITHUB_SHA || headOf(root);
}

function check(dir, root) {
  const hint = 'Use the tarballs the pack job uploaded for this commit, unchanged, or pack again with scripts/pack-packages.sh.';
  const manifest = readJson(join(dir, MANIFEST), MANIFEST);
  if (manifest.missing) fail('check', dir, [manifest.missing], hint);
  const pack = manifest.value.pack;
  if (!pack) fail('check', dir, [`${MANIFEST} has no pack record: pack with scripts/pack-packages.sh`], hint);
  const files = readdirSync(dir).filter((file) => file.endsWith('.tgz')).sort();
  const found = tarballProblems(dir, files, pack.tarballs, 'the pack record');
  const commit = checkedOutCommit(root);
  if (pack.head !== commit) found.push(`the tarballs were packed from commit ${pack.head}, and this job checked out ${commit}`);
  if (files.length === 0) found.push('the directory holds no tarballs');
  if (found.length > 0) fail('check', dir, found, hint);
  console.log(`proven-stamp: the ${files.length} tarballs in ${dir} are the ones packed from ${pack.head}`);
}

const [action, ...args] = process.argv.slice(2);
if (action === 'record' && args.length === 4) {
  record(...args);
} else if (action === 'check' && args.length === 2) {
  check(...args);
} else if ((action === 'write' || action === 'verify') && args.length >= 4) {
  const [dir, version, root, ...names] = args;
  const files = names.map((name) => `${name}-${version}.tgz`);
  if (action === 'write') write(dir, version, root, files);
  else verify(dir, version, root, files);
} else {
  console.error('usage: node scripts/lib/proven-stamp.mjs record <dir> <root> <head> <clean> | write|verify <dir> <version> <root> <name>... | check <dir> <root>');
  process.exit(2);
}
