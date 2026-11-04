#!/usr/bin/env node
// Refuse a release the npm credentials can't finish, before the first upload.
//
//   node scripts/lib/check-publish-access.mjs <package>...
//
// Uploads run in order and can't be taken back, so a token that can publish
// the first five packages and not the sixth leaves a partial release (#2029).
// Every check here is a read-only registry request:
//
//  - `npm whoami` names the account;
//  - `npm access list packages <account> --json` prints each package the
//    account can reach as `read-write` or `read-only`;
//  - `npm view <package> name` tells a package not on the registry yet (E404)
//    from one the account can't reach.
//
// A package not on the registry yet has no permission to read: publishing it
// creates it, which needs a token with read-write access across its scope (or
// to all packages, for an unscoped name). Nothing read-only proves that, so
// the owner states it: PYRIC_PUBLISH_SCOPE_WRITE lists the scopes (`@pyric`)
// or package names the token can write across. It covers only packages not on
// the registry yet; an existing package needs read-write in the listing.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const ACK_ENV = 'PYRIC_PUBLISH_SCOPE_WRITE';

export function scopeOf(name) {
  return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
}

function acknowledged(name, acks) {
  const scope = scopeOf(name);
  return acks.includes(name) || (scope !== null && acks.includes(scope));
}

/**
 * Sorts each package into what the account can publish and what it can't.
 * `access` is the parsed access listing; `onRegistry(name)` is true, false
 * (an E404), or a string saying why the registry couldn't answer.
 */
export function judgePublishAccess(packages, access, onRegistry, acks) {
  const refusals = [];
  const acknowledgedNew = [];
  for (const name of packages) {
    const permission = access[name];
    if (permission === 'read-write') continue;
    if (permission !== undefined) {
      refusals.push(`${name}: the account has ${permission} access; publishing needs read-write`);
      continue;
    }
    const exists = onRegistry(name);
    if (typeof exists === 'string') {
      refusals.push(`${name}: not in the account's package list, and the registry lookup failed (${exists})`);
    } else if (exists) {
      refusals.push(`${name}: on the registry, but not in the account's package list; grant the account and token read-write access to it`);
    } else if (acknowledged(name, acks)) {
      acknowledgedNew.push(name);
    } else {
      const scope = scopeOf(name);
      const needed = scope ? `read-write access to the ${scope} scope` : 'read-write access to all packages';
      const ack = scope ?? name;
      refusals.push(
        `${name}: not on the registry yet, so this release creates it. That needs a token with ${needed}, which no ` +
          `read-only check can prove. Once the token has it, rerun with ${ACK_ENV}=${ack}`,
      );
    }
  }
  return { refusals, acknowledgedNew };
}

function npm(args) {
  return spawnSync('npm', args, { encoding: 'utf8' });
}

function failure(run) {
  const lines = `${run.stderr ?? ''}\n${run.stdout ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines[0] ?? `exit ${run.status}`;
}

function refuse(lines) {
  console.error('✗ Refusing to publish: the npm credentials cannot publish every package in this release.');
  for (const line of lines) console.error(`  - ${line}`);
  console.error('');
  console.error('Nothing was uploaded. Fix the token, then run the release again.');
  process.exit(1);
}

function lookup(name) {
  const run = npm(['view', name, 'name']);
  if (run.status === 0) return true;
  if (/\bE404\b/.test(`${run.stderr}\n${run.stdout}`)) return false;
  return failure(run);
}

function main() {
  const packages = process.argv.slice(2);
  if (packages.length === 0) {
    console.error('usage: check-publish-access.mjs <package>...');
    process.exit(2);
  }
  const whoami = npm(['whoami']);
  const account = whoami.stdout?.trim();
  if (whoami.status !== 0 || !account) refuse([`npm whoami failed: ${failure(whoami)}`]);

  const listing = npm(['access', 'list', 'packages', account, '--json']);
  if (listing.status !== 0) refuse([`npm access list packages ${account} failed: ${failure(listing)}`]);
  let access;
  try {
    access = JSON.parse(listing.stdout || '{}');
  } catch {
    refuse([`npm access list packages ${account} did not print JSON`]);
  }

  const acks = (process.env[ACK_ENV] ?? '').split(/[\s,]+/).filter(Boolean);
  const { refusals, acknowledgedNew } = judgePublishAccess(packages, access, lookup, acks);
  if (refusals.length > 0) refuse(refusals);

  console.log(`npm publish access: ${account} can publish ${packages.length - acknowledgedNew.length} existing packages read-write.`);
  for (const name of acknowledgedNew) {
    console.log(`  ${name} is not on the registry yet; ${ACK_ENV} states the token can write across ${scopeOf(name) ?? name}.`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
