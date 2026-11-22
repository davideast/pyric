/**
 * The `sandbox` tool's branch vocabulary, which the six branch records share:
 * the branch-name shape, the two refusals four of them reuse, the project path
 * check, and the session-file reader.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH_FORMAT, BRANCH_STORE_RELATIVE } from 'pyric/sandbox/branches/store';

import { CAPTURE_RELATIVE_PATH } from '../../../../src/serve/capture-store.js';

import {
  AGAINST_LIVE,
  branchExists,
  branchName,
  readSessionEvents,
  refuseAmbiguousSource,
  refuseUnknownBranch,
  projectPathWithin,
} from '../../../../src/bridge/surface/arguments/sandbox.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('sandbox', 'seed');

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-branch-args-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Create one branch the store would list: a directory with its manifest. */
function plantBranch(name: string): void {
  const dir = join(projectDir, BRANCH_STORE_RELATIVE, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: BRANCH_FORMAT,
      created: '2026-09-09T00:00:00.000Z',
      base: 'live',
      eventCount: 0,
    }),
    'utf8',
  );
}

/** A directory under the branch store that the store never wrote. */
function plantStrayDirectory(name: string): void {
  mkdirSync(join(projectDir, BRANCH_STORE_RELATIVE, name), { recursive: true });
}

describe('branchName', () => {
  it('accepts a single lowercase path segment', () => {
    expect(branchName.safeParse('draft').success).toBe(true);
    expect(branchName.safeParse('fix-2.1_a').success).toBe(true);
  });

  it('refuses anything that is not one path segment', () => {
    expect(branchName.safeParse('../escape').success).toBe(false);
    expect(branchName.safeParse('a/b').success).toBe(false);
    expect(branchName.safeParse('Draft').success).toBe(false);
    expect(branchName.safeParse('').success).toBe(false);
  });
});

describe('branchExists', () => {
  it('reads the branch listing the store reports', () => {
    expect(branchExists(projectDir, 'draft')).toBe(false);
    plantBranch('draft');
    expect(branchExists(projectDir, 'draft')).toBe(true);
  });

  it('does not count a directory the store would not list', () => {
    plantStrayDirectory('not-a-branch');
    expect(branchExists(projectDir, 'not-a-branch')).toBe(false);
  });
});

describe('refuseUnknownBranch', () => {
  it('says there are no branches at all when there are none', () => {
    const refusal = refuseUnknownBranch(projectDir, 'draft', fail);
    expect(refusal.summary).toContain('no branches at all');
    expect(refusal.data.field).toBe('branch');
  });

  it('names the branches the project does hold', () => {
    plantBranch('alpha');
    plantBranch('beta');
    const refusal = refuseUnknownBranch(projectDir, 'draft', fail);
    expect(refusal.summary).toContain('alpha, beta');
  });

  it('names no branch the listing would leave out', () => {
    plantBranch('alpha');
    plantStrayDirectory('not-a-branch');
    const refusal = refuseUnknownBranch(projectDir, 'draft', fail);
    expect(refusal.summary).toContain('alpha');
    expect(refusal.summary).not.toContain('not-a-branch');
  });
});

describe('refuseAmbiguousSource', () => {
  it('accepts exactly one of events and sessionPath', () => {
    expect(refuseAmbiguousSource({ events: [] }, fail)).toBeNull();
    expect(refuseAmbiguousSource({ sessionPath: CAPTURE_RELATIVE_PATH }, fail)).toBeNull();
  });

  it('refuses neither, naming both options', () => {
    const refusal = refuseAmbiguousSource({}, fail);
    expect(refusal?.summary).toContain('events');
    expect(refusal?.summary).toContain('sessionPath');
  });

  it('refuses both, because they are two sources for one call', () => {
    const refusal = refuseAmbiguousSource({ events: [], sessionPath: 'x.json' }, fail);
    expect(refusal?.summary).toContain('two different sources');
  });
});

describe('projectPathWithin', () => {
  it('resolves a relative path against the project directory', () => {
    const resolved = projectPathWithin(projectDir, CAPTURE_RELATIVE_PATH, 'sessionPath', fail);
    expect(resolved).toEqual({ path: join(projectDir, CAPTURE_RELATIVE_PATH) });
  });

  it('accepts an absolute path inside the project directory', () => {
    const inside = join(projectDir, CAPTURE_RELATIVE_PATH);
    expect(projectPathWithin(projectDir, inside, 'sessionPath', fail)).toEqual({ path: inside });
  });

  it('refuses an absolute path outside the project directory', () => {
    const refused = projectPathWithin(projectDir, '/etc/hosts', 'sessionPath', fail);
    expect('path' in refused).toBe(false);
  });

  it('refuses a path that climbs out of the project directory', () => {
    const refused = projectPathWithin(projectDir, '../outside.json', 'sessionPath', fail);
    expect('path' in refused).toBe(false);
  });

  it('refuses symlinks pointing outside the project directory (existing, missing target, dangling, loop)', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'pyric-branch-args-out-'));
    try {
      const outsideFile = join(outsideDir, 'secret.json');
      writeFileSync(outsideFile, '{"secret":true}', 'utf8');
      symlinkSync(outsideFile, join(projectDir, 'escape-file.json'));
      symlinkSync(outsideDir, join(projectDir, 'escape-dir'));
      symlinkSync(join(outsideDir, 'dangling.json'), join(projectDir, 'dangling.json'));
      symlinkSync(join(projectDir, 'loop-b'), join(projectDir, 'loop-a'));
      symlinkSync(join(projectDir, 'loop-a'), join(projectDir, 'loop-b'));

      for (const candidate of [
        'escape-file.json',
        'escape-dir/secret.json',
        'escape-dir/new-export.json',
        'dangling.json',
        'loop-a',
      ]) {
        const refused = projectPathWithin(projectDir, candidate, 'path', fail);
        expect('path' in refused).toBe(false);
        if (!('path' in refused)) {
          expect(refused.summary).toContain(candidate);
          expect(refused.summary).toContain('outside the project directory');
        }
      }
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts an internal symlink whose real target stays inside the project directory', () => {
    mkdirSync(join(projectDir, 'fixtures'), { recursive: true });
    const target = join(projectDir, 'fixtures', 'seed.json');
    writeFileSync(target, '{}', 'utf8');
    symlinkSync(target, join(projectDir, 'seed-link.json'));

    const resolved = projectPathWithin(projectDir, 'seed-link.json', 'path', fail);
    expect(resolved).toEqual({ path: target });
  });

  it('handles a symlinked projectDir itself while still refusing escaping symlinks', () => {
    const outer = mkdtempSync(join(tmpdir(), 'pyric-branch-args-symroot-'));
    try {
      const realProject = join(outer, 'real-project');
      const outside = join(outer, 'outside');
      const symlinkedProject = join(outer, 'link-project');
      mkdirSync(realProject, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(realProject, 'inside.json'), '{}', 'utf8');
      writeFileSync(join(outside, 'secret.json'), '{}', 'utf8');
      symlinkSync(realProject, symlinkedProject);
      symlinkSync(join(outside, 'secret.json'), join(realProject, 'escape.json'));

      const ok = projectPathWithin(symlinkedProject, 'inside.json', 'path', fail);
      expect(ok).toEqual({ path: join(symlinkedProject, 'inside.json') });

      const refused = projectPathWithin(symlinkedProject, 'escape.json', 'path', fail);
      expect('path' in refused).toBe(false);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('refuses symlink + .. lexical-collapse escapes without silently redirecting', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pyric-branch-args-trick-'));
    try {
      const outsideDeep = join(outside, 'deep');
      mkdirSync(outsideDeep, { recursive: true });
      symlinkSync(outsideDeep, join(projectDir, 'escape_dir'));
      symlinkSync('escape_dir/../pwned.json', join(projectDir, 'trick.json'));
      symlinkSync('escape_dir/./../pwned2.json', join(projectDir, 'trick2.json'));
      symlinkSync('escape_dir/nonexistent/../../../inside.json', join(projectDir, 'trick3.json'));

      for (const candidate of ['trick.json', 'trick2.json', 'escape_dir/../pwned.json', 'trick3.json']) {
        const refused = projectPathWithin(projectDir, candidate, 'path', fail);
        expect('path' in refused).toBe(false);
        if (!('path' in refused)) {
          expect(refused.summary).toContain(candidate);
          expect(refused.summary).toContain('outside the project directory');
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('readSessionEvents', () => {
  it('reads the events array of a capture fixture', () => {
    const path = join(projectDir, 'session.json');
    writeFileSync(path, JSON.stringify({ schema: 'x', events: [{ kind: 'write' }] }));
    expect(readSessionEvents(path)).toHaveLength(1);
  });

  it('reads a bare event array', () => {
    const path = join(projectDir, 'events.json');
    writeFileSync(path, JSON.stringify([{ kind: 'write' }]));
    expect(readSessionEvents(path)).toHaveLength(1);
  });

  it('reports nothing for a file that carries no events', () => {
    const path = join(projectDir, 'other.json');
    writeFileSync(path, JSON.stringify({ nothing: true }));
    expect(readSessionEvents(path)).toBeNull();
  });
});

describe('AGAINST_LIVE', () => {
  it('names the live sandbox rather than a checkpoint', () => {
    expect(AGAINST_LIVE).toBe('live');
  });
});
