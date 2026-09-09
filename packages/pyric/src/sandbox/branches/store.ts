/**
 * Persisted branches: the on-disk form of the in-memory branch primitive.
 *
 * THE FORMAT, stated once because the CLI and Studio both read it.
 *
 *   <project>/.pyric/state/branches/<name>/
 *     manifest.json      { format, created, base, eventCount }
 *     base.bundle.json   the forked base snapshot, in the v3 record bundle
 *                        the headless snapshot file already uses
 *     events.json        the applied event log, a JSON array of SandboxEvent
 *     rules.firestore    the candidate rules the branch was forked with,
 *                        absent when the fork carried none
 *
 * The directory name is the branch name and is the join key, so the manifest
 * does not repeat it: the directory is the index, exactly as the authored
 * record convention states. `base` is `live` or the name of the checkpoint the
 * fork was taken from. A branch is stored as its base plus its events rather
 * than as its current state, so what `loadBranch` returns is reproduced by the
 * same `fork` and `apply` the engine runs, and the file a reader opens cannot
 * disagree with the engine about what the branch is.
 *
 * This module reads and writes files, so it is Node only and is published at
 * the `pyric/sandbox/branches/store` subpath rather than from the browser
 * barrel `pyric/sandbox`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bundleRecords,
  deserializeFromBuckets,
  parseBundle,
  serializeToBuckets,
} from '../persistence/chunk-format.js';
import type { SandboxEvent, SandboxSnapshot } from '../types/index.js';
import { apply, fork, type Branch } from './index.js';

/** The tag every branch manifest carries, so an unrelated directory is not read as one. */
export const BRANCH_FORMAT = 'pyric-branch-v1';

/** Where branches live, relative to the project directory. */
export const BRANCH_STORE_RELATIVE = join('.pyric', 'state', 'branches');

const MANIFEST_FILE = 'manifest.json';
const BASE_FILE = 'base.bundle.json';
const EVENTS_FILE = 'events.json';
const RULES_FILE = 'rules.firestore';

/** The names a branch may take: one path segment, so a name can never escape the store. */
const BRANCH_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A branch name the store refuses. Thrown rather than returned: it is a caller mistake. */
export class BranchNameError extends Error {
  constructor(name: string) {
    super(
      `'${name}' is not a branch name. A branch name is 1 to 64 characters of lowercase letters, digits, dot, dash, or underscore, starting with a letter or digit.`,
    );
    this.name = 'BranchNameError';
  }
}

/** The manifest a branch directory carries, without the name its directory already states. */
export interface BranchManifest {
  format: typeof BRANCH_FORMAT;
  /** When the branch was forked, as an ISO 8601 instant. */
  created: string;
  /** `live`, or the name of the checkpoint the fork was taken from. */
  base: string;
  /** How many events have been applied to the branch. */
  eventCount: number;
}

/** One entry of a branch listing: the manifest plus the name the directory carries. */
export interface BranchListing extends BranchManifest {
  name: string;
}

/** A loaded branch: the rebuilt in-memory branch plus what the manifest recorded. */
export interface LoadedBranch {
  name: string;
  branch: Branch;
  manifest: BranchManifest;
}

/** What a save records beyond the branch itself. */
export interface SaveBranchOptions {
  /** `live`, or the name of the checkpoint the fork was taken from. */
  base: string;
  /** The creation instant to record. Defaults to now, which is what a fork wants. */
  created?: string;
}

/** Reject a name that is not one path segment of the branch store. */
function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name)) throw new BranchNameError(name);
}

/** The directory one branch occupies. */
export function branchDirectory(projectDir: string, name: string): string {
  assertBranchName(name);
  return join(projectDir, BRANCH_STORE_RELATIVE, name);
}

/** The v3 bundle text for one snapshot's Firestore documents and service state. */
function encodeSnapshot(snapshot: SandboxSnapshot): string {
  return bundleRecords(serializeToBuckets(snapshot.firestore, snapshot.services, 0));
}

/** The snapshot one bundle text carries. */
function decodeSnapshot(bundle: string): SandboxSnapshot {
  const { firestore, services } = deserializeFromBuckets(parseBundle(bundle));
  return { firestore, services };
}

/**
 * Write one branch to its own directory, replacing whatever was there. The
 * base snapshot and the event log are written from the branch itself, so a
 * save after an `apply` records exactly what the engine holds.
 */
export function saveBranch(
  projectDir: string,
  name: string,
  branch: Branch,
  options: SaveBranchOptions,
): BranchManifest {
  const dir = branchDirectory(projectDir, name);
  const manifest: BranchManifest = {
    format: BRANCH_FORMAT,
    created: options.created ?? new Date().toISOString(),
    base: options.base,
    eventCount: branch.events.length,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, BASE_FILE), encodeSnapshot(branch.base), 'utf8');
  writeFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(branch.events)}\n`, 'utf8');
  const rulesPath = join(dir, RULES_FILE);
  if (branch.rules === '') {
    rmSync(rulesPath, { force: true });
  } else {
    writeFileSync(rulesPath, branch.rules, 'utf8');
  }
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** The manifest one directory holds, or null when it holds none this store wrote. */
function readManifest(dir: string): BranchManifest | null {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  let parsed: Partial<BranchManifest>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BranchManifest>;
  } catch {
    return null;
  }
  if (parsed.format !== BRANCH_FORMAT) return null;
  if (typeof parsed.created !== 'string') return null;
  if (typeof parsed.base !== 'string') return null;
  if (typeof parsed.eventCount !== 'number') return null;
  return {
    format: BRANCH_FORMAT,
    created: parsed.created,
    base: parsed.base,
    eventCount: parsed.eventCount,
  };
}

/** The rules one branch directory carries, or the empty source when it carries none. */
function readRules(dir: string): string {
  const path = join(dir, RULES_FILE);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/** The event log one branch directory carries. */
function readEvents(dir: string): SandboxEvent[] {
  const path = join(dir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as SandboxEvent[];
}

/**
 * Rebuild one branch from its directory, or null when the project has no
 * branch by that name. The branch is rebuilt the way it was built: `fork` on
 * the stored base, then `apply` of the stored events, so a loaded branch and a
 * branch that never left memory are the same value.
 */
export function loadBranch(projectDir: string, name: string): LoadedBranch | null {
  const dir = branchDirectory(projectDir, name);
  const manifest = readManifest(dir);
  if (manifest === null) return null;
  const base = decodeSnapshot(readFileSync(join(dir, BASE_FILE), 'utf8'));
  const branch = fork(base, readRules(dir));
  const events = readEvents(dir);
  if (events.length > 0) apply(branch, events);
  return { name, branch, manifest };
}

/**
 * Every branch the project holds, ordered by name. A directory that carries no
 * manifest this store wrote is skipped rather than failing the listing, so an
 * unrelated file under the branch directory does not take the listing down.
 */
export function listBranches(projectDir: string): BranchListing[] {
  const root = join(projectDir, BRANCH_STORE_RELATIVE);
  if (!existsSync(root)) return [];
  const listed: BranchListing[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!BRANCH_NAME.test(entry.name)) continue;
    const manifest = readManifest(join(root, entry.name));
    if (manifest === null) continue;
    listed.push({ name: entry.name, ...manifest });
  }
  return listed.sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove one branch directory. Returns whether there was one to remove. */
export function removeBranch(projectDir: string, name: string): boolean {
  const dir = branchDirectory(projectDir, name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
