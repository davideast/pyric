/**
 * The branch store: the on-disk form of a branch and the round trip through
 * it. What these pin is the format and the loader, not the fork, apply, diff,
 * promote, or discard semantics, which `engine.test.ts` covers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, fork } from '../../../src/sandbox/branches/index.js';
import {
  BRANCH_FORMAT,
  BRANCH_STORE_RELATIVE,
  BranchNameError,
  branchDirectory,
  listBranches,
  loadBranch,
  removeBranch,
  saveBranch,
} from '../../../src/sandbox/branches/store.js';
import { captureFullState } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { CANDIDATE_FIRESTORE_RULES, populatedSandbox } from './fixtures.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-branch-store-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A branch forked from a sandbox holding state in every service. */
async function populatedBranch(candidate?: string) {
  return fork(await captureFullState(await populatedSandbox()), candidate);
}

describe('the branch store', () => {
  it('writes one directory per branch, named by the branch', async () => {
    const branch = await populatedBranch();
    saveBranch(projectDir, 'draft', branch, { base: 'live' });

    const dir = branchDirectory(projectDir, 'draft');
    expect(dir).toBe(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      format: string;
      base: string;
      eventCount: number;
      created: unknown;
    };
    expect(manifest.format).toBe('pyric-branch-v2');
    expect(manifest.format).toBe(BRANCH_FORMAT);
    expect(manifest.base).toBe('live');
    expect(manifest.eventCount).toBe(0);
    expect(typeof manifest.created).toBe('string');
  });

  it('writes the base state as one file per service', async () => {
    saveBranch(projectDir, 'draft', await populatedBranch(), { base: 'live' });
    const base = join(branchDirectory(projectDir, 'draft'), 'base');

    for (const service of ['firestore', 'database', 'storage', 'auth', 'rules']) {
      expect(existsSync(join(base, `${service}.json`))).toBe(true);
    }
    const storage = JSON.parse(readFileSync(join(base, 'storage.json'), 'utf8')) as Array<{
      path: string;
    }>;
    expect(storage.map((object) => object.path)).toEqual(['docs/hello.txt']);
  });

  it('keeps the branch name out of the manifest, because the directory carries it', async () => {
    saveBranch(projectDir, 'draft', await populatedBranch(), { base: 'live' });
    const raw = readFileSync(join(branchDirectory(projectDir, 'draft'), 'manifest.json'), 'utf8');
    expect(raw).not.toContain('draft');
  });

  it('reloads a persisted branch to an identical full state', async () => {
    const branch = await populatedBranch();
    getInternalEnv(branch.sandbox).execute({
      method: 'set',
      path: 'notes/n2',
      data: { body: 'branch' },
      auth: null,
    });
    apply(branch, branch.sandbox.history());
    const expected = await captureFullState(branch.sandbox);
    saveBranch(projectDir, 'draft', branch, { base: 'live' });

    const loaded = await loadBranch(projectDir, 'draft');
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.base).toBe('live');
    expect(await captureFullState(loaded!.branch.sandbox)).toEqual(expected);
    expect(loaded!.branch.base).toEqual(branch.base);
  });

  it('round trips the candidate rules the fork installed', async () => {
    const branch = await populatedBranch(CANDIDATE_FIRESTORE_RULES);
    saveBranch(projectDir, 'draft', branch, { base: 'live' });

    const loaded = await loadBranch(projectDir, 'draft');
    expect(loaded!.branch.candidateRules).toEqual({ firestore: CANDIDATE_FIRESTORE_RULES });
    expect(getInternalEnv(loaded!.branch.sandbox).getRules()).toBe(CANDIDATE_FIRESTORE_RULES);
  });

  it('lists every stored branch by directory name, with its manifest fields', async () => {
    saveBranch(projectDir, 'beta', await populatedBranch(), { base: 'live' });
    saveBranch(projectDir, 'alpha', await populatedBranch(), { base: 'nightly' });

    const listed = listBranches(projectDir);
    expect(listed.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(listed[0]!.base).toBe('nightly');
    expect(listed[0]!.eventCount).toBe(0);
  });

  it('lists nothing when the project has no branch directory', () => {
    expect(listBranches(projectDir)).toEqual([]);
  });

  it('skips a directory that holds no manifest rather than failing the listing', async () => {
    saveBranch(projectDir, 'good', await populatedBranch(), { base: 'live' });
    mkdirSync(join(projectDir, BRANCH_STORE_RELATIVE, 'rubble'), { recursive: true });
    writeFileSync(join(projectDir, BRANCH_STORE_RELATIVE, 'rubble', 'other.txt'), 'x');
    expect(listBranches(projectDir).map((entry) => entry.name)).toEqual(['good']);
  });

  it('returns null for a branch that was never stored', async () => {
    expect(await loadBranch(projectDir, 'absent')).toBeNull();
  });

  it('removes a branch directory and reports whether there was one', async () => {
    saveBranch(projectDir, 'draft', await populatedBranch(), { base: 'live' });
    expect(removeBranch(projectDir, 'draft')).toBe(true);
    expect(listBranches(projectDir)).toEqual([]);
    expect(removeBranch(projectDir, 'draft')).toBe(false);
  });

  it('refuses a branch name that would escape the branch directory', async () => {
    const branch = await populatedBranch();
    expect(() => saveBranch(projectDir, '../escape', branch, { base: 'live' })).toThrow(
      BranchNameError,
    );
    expect(loadBranch(projectDir, '..')).rejects.toThrow(BranchNameError);
    expect(() => removeBranch(projectDir, 'a/b')).toThrow(BranchNameError);
  });

  it('omits the candidate rules file for a branch forked with none', async () => {
    saveBranch(projectDir, 'plain', await populatedBranch(), { base: 'live' });
    const path = join(branchDirectory(projectDir, 'plain'), 'candidate-rules.json');
    expect(existsSync(path)).toBe(false);

    const loaded = await loadBranch(projectDir, 'plain');
    expect(loaded!.branch.candidateRules).toEqual({});
  });
});
