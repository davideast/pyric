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
//    from one the account can't reach;
//  - `npm access list collaborators <package> --json` prints each account
//    with access to one package. When the account listing fails (the org
//    endpoint can answer E403, and libnpmaccess falls back to the user
//    endpoint only on E404) or leaves an existing package out, the package
//    passes only if the account is a `read-write` collaborator on it.
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
 * `access` is the parsed account listing ({} when it failed);
 * `onRegistry(name)` is true, false (an E404), or a string saying why the
 * registry couldn't answer; `collaborator(name)` is the account's permission
 * on that package (`read-write`, `read-only`, or undefined when unlisted), or
 * `{ error }` when the request failed.
 */
export function judgePublishAccess(packages, access, onRegistry, collaborator, acks) {
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
      const refusal = collaboratorRefusal(name, collaborator(name));
      if (refusal) refusals.push(refusal);
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

function collaboratorRefusal(name, permission) {
  if (permission === 'read-write') return null;
  if (permission !== null && typeof permission === 'object') {
    return `${name}: not in the account's package list, and its collaborator list failed (${permission.error})`;
  }
  const held = permission === undefined ? 'no access' : `${permission} access`;
  return `${name}: on the registry, and the account has ${held} as a collaborator; grant the account and token read-write access to it`;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
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

  // A failed listing isn't a refusal yet: each package falls back to its
  // collaborator list. A listing that answers with something other than an
  // object is.
  const listing = npm(['access', 'list', 'packages', account, '--json']);
  let access = {};
  if (listing.status === 0) {
    access = parseObject(listing.stdout);
    if (access === null) refuse([`npm access list packages ${account} did not print JSON`]);
  } else {
    console.log(`npm access list packages ${account} failed (${failure(listing)}); checking each package's collaborators.`);
  }

  const collaborator = (name) => {
    const run = npm(['access', 'list', 'collaborators', name, '--json']);
    if (run.status !== 0) return { error: failure(run) };
    const collaborators = parseObject(run.stdout);
    if (collaborators === null) return { error: 'did not print JSON' };
    return collaborators[account];
  };

  const acks = (process.env[ACK_ENV] ?? '').split(/[\s,]+/).filter(Boolean);
  const { refusals, acknowledgedNew } = judgePublishAccess(packages, access, lookup, collaborator, acks);
  if (refusals.length > 0) refuse(refusals);

  console.log(`npm publish access: ${account} can publish ${packages.length - acknowledgedNew.length} existing packages read-write.`);
  for (const name of acknowledgedNew) {
    console.log(`  ${name} is not on the registry yet; ${ACK_ENV} states the token can write across ${scopeOf(name) ?? name}.`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
