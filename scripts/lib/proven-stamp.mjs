#!/usr/bin/env node
// The record that a set of packed tarballs passed every pre-publish gate.
//
//   node scripts/lib/proven-stamp.mjs write  <packages dir> <version> <repo root>
//   node scripts/lib/proven-stamp.mjs verify <packages dir> <version> <repo root>
//
// publish-alpha.sh writes it once every gate has passed on the tarballs, and
// a gate-skipping rerun (PYRIC_PUBLISH_SKIP_GATES=1) verifies it before it
// uploads anything: the stamp must name this commit, a clean tree then and
// now, this version, and the sha256 of every tarball on disk. Anything else
// (tarballs from an earlier commit, a pack whose checks failed, a failed
// build's leftovers) is refused, so the rerun uploads only bytes that passed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STAMP = 'proven.json';

function headOf(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function isClean(root) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
}

function tarballHashes(dir, version) {
  const suffix = `-${version}.tgz`;
  const files = readdirSync(dir).filter((file) => file.endsWith(suffix)).sort();
  return Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')]));
}

function write(dir, version, root) {
  const stamp = { head: headOf(root), clean: isClean(root), version, tarballs: tarballHashes(dir, version) };
  writeFileSync(join(dir, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  console.log(`proven-stamp: ${Object.keys(stamp.tarballs).length} tarballs proven on ${stamp.head}${stamp.clean ? '' : ' (tree not clean)'}`);
}

/** Every reason the tarballs on disk are not the ones the stamp proved. */
function problems(dir, version, root) {
  const path = join(dir, STAMP);
  if (!existsSync(path)) return [`no ${STAMP} in ${dir}: no gate run proved these tarballs`];
  const stamp = JSON.parse(readFileSync(path, 'utf8'));
  const found = [];
  if (stamp.version !== version) found.push(`the tarballs were proven for ${stamp.version}, not ${version}`);
  const head = headOf(root);
  if (stamp.head !== head) found.push(`the tarballs were proven on commit ${stamp.head}, and HEAD is ${head}`);
  if (!stamp.clean) found.push('the tree had uncommitted changes when the tarballs were proven');
  if (!isClean(root)) found.push('the tree has uncommitted changes now');
  const onDisk = tarballHashes(dir, version);
  const names = new Set([...Object.keys(onDisk), ...Object.keys(stamp.tarballs ?? {})]);
  for (const name of [...names].sort()) {
    const isSame = onDisk[name] !== undefined && onDisk[name] === stamp.tarballs?.[name];
    if (!isSame) found.push(`${name} is not the file the gates passed`);
  }
  return found;
}

function verify(dir, version, root) {
  const found = problems(dir, version, root);
  if (found.length > 0) {
    console.error(`proven-stamp: refusing to upload ${dir}:\n${found.map((line) => `  - ${line}`).join('\n')}\nRun the publish again without PYRIC_PUBLISH_SKIP_GATES so the gates prove a fresh pack.`);
    process.exit(1);
  }
  console.log(`proven-stamp: the tarballs in ${dir} are the ones proven on ${headOf(root)}`);
}

const [action, dir, version, root] = process.argv.slice(2);
if (!dir || !version || !root) {
  console.error('usage: node scripts/lib/proven-stamp.mjs write|verify <packages dir> <version> <repo root>');
  process.exit(2);
}
if (action === 'write') write(dir, version, root);
else if (action === 'verify') verify(dir, version, root);
else {
  console.error(`proven-stamp: unknown action "${action}"`);
  process.exit(2);
}
