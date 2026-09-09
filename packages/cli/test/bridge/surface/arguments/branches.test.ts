/**
 * The branch methods' shared argument vocabulary: the branch-name shape, the
 * two refusals four records reuse, the project-relative path check, and the
 * session-file reader.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGAINST_LIVE,
  DEFAULT_SESSION_PATH,
  branchExists,
  branchName,
  readSessionEvents,
  refuseAmbiguousSource,
  refuseUnknownBranch,
  resolveProjectPath,
} from '../../../../src/bridge/surface/arguments/branches.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('sandbox', 'apply');

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-branch-args-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Create one branch directory, which is all these reads look at. */
function plantBranch(name: string): void {
  mkdirSync(join(projectDir, '.pyric', 'state', 'branches', name), { recursive: true });
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
  it('reads the branch directory listing', () => {
    expect(branchExists(projectDir, 'draft')).toBe(false);
    plantBranch('draft');
    expect(branchExists(projectDir, 'draft')).toBe(true);
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
});

describe('refuseAmbiguousSource', () => {
  it('accepts exactly one of events and sessionPath', () => {
    expect(refuseAmbiguousSource({ events: [] }, fail)).toBeNull();
    expect(refuseAmbiguousSource({ sessionPath: DEFAULT_SESSION_PATH }, fail)).toBeNull();
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

describe('resolveProjectPath', () => {
  it('resolves a relative path against the project directory', () => {
    const resolved = resolveProjectPath(projectDir, DEFAULT_SESSION_PATH, 'sessionPath', fail);
    expect(resolved).toEqual({ path: join(projectDir, DEFAULT_SESSION_PATH) });
  });

  it('refuses an absolute path', () => {
    const refused = resolveProjectPath(projectDir, '/etc/hosts', 'sessionPath', fail);
    expect('path' in refused).toBe(false);
  });

  it('refuses a path that climbs out of the project directory', () => {
    const refused = resolveProjectPath(projectDir, '../outside.json', 'sessionPath', fail);
    expect('path' in refused).toBe(false);
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
