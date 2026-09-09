/**
 * The branch store: the on-disk form of a branch and the round trip through
 * it. The engine is unchanged, so what these pin is the format and the loader,
 * not the fork, apply, diff, promote, or discard semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-branch-store-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A live sandbox holding one document. */
function liveSandbox() {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({ rules: RULES, documents: { 'notes/n1': { body: 'base' } } });
  return sandbox;
}

describe('the branch store', () => {
  it('writes one directory per branch, named by the branch', () => {
    const live = liveSandbox();
    const branch = fork(live.snapshot(), RULES);
    saveBranch(projectDir, 'draft', branch, { base: 'live' });

    const dir = branchDirectory(projectDir, 'draft');
    expect(dir).toBe(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      format: string;
      base: string;
      eventCount: number;
      created: unknown;
    };
    expect(manifest.format).toBe(BRANCH_FORMAT);
    expect(manifest.base).toBe('live');
    expect(manifest.eventCount).toBe(0);
    expect(typeof manifest.created).toBe('string');
  });

  it('keeps the branch name out of the manifest, because the directory carries it', () => {
    const branch = fork(liveSandbox().snapshot(), RULES);
    saveBranch(projectDir, 'draft', branch, { base: 'live' });
    const raw = readFileSync(join(branchDirectory(projectDir, 'draft'), 'manifest.json'), 'utf8');
    expect(raw).not.toContain('draft');
  });

  it('round trips the base snapshot, the rules, and the applied events', () => {
    const live = liveSandbox();
    const branch = fork(live.snapshot(), RULES);
    const branchEnv = getInternalEnv(branch.sandbox);
    branchEnv.execute({ method: 'set', path: 'notes/n2', data: { body: 'branch' }, auth: null });
    apply(branch, branch.sandbox.history());
    saveBranch(projectDir, 'draft', branch, { base: 'live' });

    const loaded = loadBranch(projectDir, 'draft');
    expect(loaded).not.toBeNull();
    expect(loaded!.manifest.base).toBe('live');
    expect(loaded!.branch.rules).toBe(RULES);
    expect(loaded!.branch.base.firestore['notes/n1']).toEqual({ body: 'base' });
    expect(getInternalEnv(loaded!.branch.sandbox).snapshot()['notes/n2']).toEqual({
      body: 'branch',
    });
  });

  it('lists every stored branch by directory name, with its manifest fields', () => {
    const live = liveSandbox();
    saveBranch(projectDir, 'beta', fork(live.snapshot(), RULES), { base: 'live' });
    saveBranch(projectDir, 'alpha', fork(live.snapshot(), RULES), { base: 'nightly' });

    const listed = listBranches(projectDir);
    expect(listed.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(listed[0]!.base).toBe('nightly');
    expect(listed[0]!.eventCount).toBe(0);
  });

  it('lists nothing when the project has no branch directory', () => {
    expect(listBranches(projectDir)).toEqual([]);
  });

  it('skips a directory that holds no manifest rather than failing the listing', () => {
    saveBranch(projectDir, 'good', fork(liveSandbox().snapshot(), RULES), { base: 'live' });
    mkdirSync(join(projectDir, BRANCH_STORE_RELATIVE, 'rubble'), { recursive: true });
    writeFileSync(join(projectDir, BRANCH_STORE_RELATIVE, 'rubble', 'other.txt'), 'x');
    expect(listBranches(projectDir).map((entry) => entry.name)).toEqual(['good']);
  });

  it('returns null for a branch that was never stored', () => {
    expect(loadBranch(projectDir, 'absent')).toBeNull();
  });

  it('removes a branch directory and reports whether there was one', () => {
    saveBranch(projectDir, 'draft', fork(liveSandbox().snapshot(), RULES), { base: 'live' });
    expect(removeBranch(projectDir, 'draft')).toBe(true);
    expect(listBranches(projectDir)).toEqual([]);
    expect(removeBranch(projectDir, 'draft')).toBe(false);
  });

  it('refuses a branch name that would escape the branch directory', () => {
    const branch = fork(liveSandbox().snapshot(), RULES);
    expect(() => saveBranch(projectDir, '../escape', branch, { base: 'live' })).toThrow(
      BranchNameError,
    );
    expect(() => loadBranch(projectDir, '..')).toThrow(BranchNameError);
    expect(() => removeBranch(projectDir, 'a/b')).toThrow(BranchNameError);
  });

  it('omits the rules file for a branch forked with no candidate rules', () => {
    const branch = fork(liveSandbox().snapshot());
    saveBranch(projectDir, 'plain', branch, { base: 'live' });
    const loaded = loadBranch(projectDir, 'plain');
    expect(loaded!.branch.rules).toBe('');
  });
});
