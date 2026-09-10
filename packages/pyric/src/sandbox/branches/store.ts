/**
 * Persisted branches: the on-disk form of the in-memory branch primitive.
 *
 * THE FORMAT, stated once because the CLI and Studio both read it.
 *
 *   <project>/.pyric/state/branches/<name>/
 *     manifest.json          { format, created, base, eventCount }
 *     events.json            the applied event log, a JSON array of SandboxEvent
 *     candidate-rules.json   the rule sources the fork installed in place of
 *                            the base's, absent when the fork installed none
 *     base/firestore.json    the forked base state, one file per service:
 *     base/database.json       documents, the Realtime Database envelope,
 *     base/storage.json        objects with base64 bytes and metadata,
 *     base/auth.json           accounts and provider config, and the three
 *     base/rules.json          rule sources
 *     state/<service>.json   what the branch holds now, the same five files
 *
 * One file per service rather than one bundle, so a reader opening the
 * directory sees which services a branch carries without decoding anything,
 * and two changes to different services never rewrite the same file. The
 * directory name is the branch name and is the join key, so the manifest does
 * not repeat it: the directory is the index, exactly as the authored record
 * convention states. `base` is `live` or the name of the checkpoint the fork
 * was taken from.
 *
 * Why the branch carries two states rather than a base and a replayable log.
 * The event log records Firestore writes, which is one of the five services a
 * branch holds. A branch that had uploaded a Storage object or created an
 * account could not be rebuilt from its base and its log, so the log is what
 * was applied and `state/` is what the branch holds. `base/` stays because a
 * promotion is a delta against it: state on the target the branch never
 * touched has to survive landing, and only the base says which state that is.
 *
 * This module reads and writes files, so it is Node only and is published at
 * the `pyric/sandbox/branches/store` subpath rather than from the browser
 * barrel `pyric/sandbox`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SANDBOX_SERVICES,
  captureFullState,
  type FullSandboxState,
  type SandboxService,
} from '../full-state.js';
import type { SandboxEvent } from '../types/index.js';
import { fork, type Branch, type BranchCandidateRules } from './engine.js';

/** The tag every branch manifest carries, so an unrelated directory is not read as one. */
export const BRANCH_FORMAT = 'pyric-branch-v2';

/** Where branches live, relative to the project directory. */
export const BRANCH_STORE_RELATIVE = join('.pyric', 'state', 'branches');

const MANIFEST_FILE = 'manifest.json';
const EVENTS_FILE = 'events.json';
const CANDIDATE_RULES_FILE = 'candidate-rules.json';
const BASE_DIRECTORY = 'base';
const STATE_DIRECTORY = 'state';

/** The names a branch may take: one path segment, so a name can never escape the store. */
export const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
  if (!BRANCH_NAME_PATTERN.test(name)) throw new BranchNameError(name);
}

/** The directory one branch occupies. */
export function branchDirectory(projectDir: string, name: string): string {
  assertBranchName(name);
  return join(projectDir, BRANCH_STORE_RELATIVE, name);
}

/** The file one service's slice of a stored state occupies. */
function stateServicePath(dir: string, stateDir: string, service: SandboxService): string {
  return join(dir, stateDir, `${service}.json`);
}

/** Write one full state as one file per service. */
function writeState(dir: string, stateDir: string, state: FullSandboxState): void {
  mkdirSync(join(dir, stateDir), { recursive: true });
  for (const service of SANDBOX_SERVICES) {
    writeFileSync(
      stateServicePath(dir, stateDir, service),
      `${JSON.stringify(state[service])}\n`,
      'utf8',
    );
  }
}

/** Read one service's slice back, or null when the branch directory has no such file. */
function readSandboxService(dir: string, stateDir: string, service: SandboxService): unknown {
  const path = stateServicePath(dir, stateDir, service);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** One full state a branch directory carries, under `base/` or under `state/`. */
function readState(dir: string, stateDir: string): FullSandboxState {
  return {
    firestore: (readSandboxService(dir, stateDir, 'firestore') ?? {}) as FullSandboxState['firestore'],
    database: readSandboxService(dir, stateDir, 'database') as FullSandboxState['database'],
    storage: (readSandboxService(dir, stateDir, 'storage') ?? []) as FullSandboxState['storage'],
    auth: (readSandboxService(dir, stateDir, 'auth') ?? {
      users: [],
      providers: {},
    }) as FullSandboxState['auth'],
    rules: (readSandboxService(dir, stateDir, 'rules') ?? {
      firestore: '',
      database: null,
      storage: null,
    }) as FullSandboxState['rules'],
  };
}

/**
 * Write one branch to its own directory, replacing whatever was there. The
 * base, the current state, and the event log are all written from the branch
 * itself, so a save after an `apply` or after a write on any service records
 * exactly what the engine holds.
 */
export async function saveBranch(
  projectDir: string,
  name: string,
  branch: Branch,
  options: SaveBranchOptions,
): Promise<BranchManifest> {
  const dir = branchDirectory(projectDir, name);
  const manifest: BranchManifest = {
    format: BRANCH_FORMAT,
    created: options.created ?? new Date().toISOString(),
    base: options.base,
    eventCount: branch.events.length,
  };
  const current = await captureFullState(branch.sandbox);
  mkdirSync(dir, { recursive: true });
  writeState(dir, BASE_DIRECTORY, branch.base);
  writeState(dir, STATE_DIRECTORY, current);
  writeFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(branch.events)}\n`, 'utf8');
  const candidateRulesPath = join(dir, CANDIDATE_RULES_FILE);
  const hasCandidateRules = Object.keys(branch.candidateRules).length > 0;
  if (hasCandidateRules) {
    writeFileSync(candidateRulesPath, `${JSON.stringify(branch.candidateRules)}\n`, 'utf8');
  } else {
    rmSync(candidateRulesPath, { force: true });
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

/** The candidate rules one branch directory carries, empty when it carries none. */
function readCandidateRules(dir: string): BranchCandidateRules {
  const path = join(dir, CANDIDATE_RULES_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as BranchCandidateRules;
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
 * branch by that name. The branch's sandbox is forked onto the stored current
 * state, and the stored base and event log are restored beside it, so a loaded
 * branch and a branch that never left memory are the same value in every
 * service rather than only in the one the event log records.
 */
export async function loadBranch(
  projectDir: string,
  name: string,
): Promise<LoadedBranch | null> {
  const dir = branchDirectory(projectDir, name);
  const manifest = readManifest(dir);
  if (manifest === null) return null;
  const forked = await fork(readState(dir, STATE_DIRECTORY), readCandidateRules(dir));
  const branch: Branch = {
    sandbox: forked.sandbox,
    candidateRules: forked.candidateRules,
    base: readState(dir, BASE_DIRECTORY),
    events: readEvents(dir),
    discarded: false,
  };
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
    if (!BRANCH_NAME_PATTERN.test(entry.name)) continue;
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
