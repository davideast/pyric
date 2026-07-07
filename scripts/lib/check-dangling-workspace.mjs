#!/usr/bin/env node
// Scan every workspace package.json (root + packages/* + examples/*)
// for `workspace:*` deps that don't resolve to an actual workspace
// package. Prints each dangling ref on its own line to stdout; exits 0
// either way (caller decides what to do with the output).
//
// Catches:
//   - Removing a workspace package without updating its consumers
//   - Renaming a workspace package and missing a consumer
//   - Typos in workspace dep names
//
// Why this exists: dropping @inbrowser/resumable from the workspace
// (post-mirror-followups section 1) almost shipped without an overrides entry
// for @inbrowser/relay's busted transitive workspace: ref. This check
// surfaces the symmetric local mistake — a dangling workspace: ref in
// OUR own package.json files — at PR time instead of bun-install time.
//
// Run from the monorepo root.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const valid = new Set();
for (const dir of readdirSync('packages')) {
  const pj = join('packages', dir, 'package.json');
  try {
    if (!statSync(pj).isFile()) continue;
    const meta = JSON.parse(readFileSync(pj, 'utf-8'));
    if (meta.name) valid.add(meta.name);
  } catch {
    // skip dirs without a readable package.json
  }
}

const manifests = ['package.json'];
for (const base of ['packages', 'examples']) {
  let entries;
  try { entries = readdirSync(base); } catch { continue; }
  for (const dir of entries) {
    const pj = join(base, dir, 'package.json');
    try { if (statSync(pj).isFile()) manifests.push(pj); } catch {}
  }
}

const dangling = [];
for (const m of manifests) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(m, 'utf-8')); } catch { continue; }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [name, spec] of Object.entries(pkg[field])) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      if (!valid.has(name)) {
        dangling.push(`${m}: ${field}["${name}"] = "${spec}"`);
      }
    }
  }
}

if (dangling.length > 0) console.log(dangling.join('\n'));
