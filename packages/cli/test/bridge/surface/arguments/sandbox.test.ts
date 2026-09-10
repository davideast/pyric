/**
 * The `sandbox` tool's argument vocabulary: the `seed` payload schemas, the
 * check that a `users` entry carries only the Admin SDK's own field names with
 * a rename suggestion for the client SDK's spelling of the two fields it names
 * differently, and the branch vocabulary the six branch records share: the
 * branch-name shape, the two refusals four of them reuse, the project path
 * check, and the session-file reader.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANCH_FORMAT, BRANCH_STORE_RELATIVE } from 'pyric/sandbox/branches/store';

import { CAPTURE_RELATIVE_PATH } from '../../../../src/serve/capture-store.js';

import {
  AGAINST_LIVE,
  branchExists,
  branchName,
  checkUserFields,
  readSessionEvents,
  refuseAmbiguousSource,
  refuseUnknownBranch,
  projectPathWithin,
  storageObjectSeed,
  userSeed,
} from '../../../../src/bridge/surface/arguments/sandbox.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('sandbox', 'seed');

describe('userSeed', () => {
  it('requires uid and accepts the optional Admin SDK fields', () => {
    expect(userSeed.safeParse({ uid: 'alice' }).success).toBe(true);
    expect(
      userSeed.safeParse({
        uid: 'alice',
        email: 'alice@example.com',
        customClaims: { role: 'owner' },
        tenantId: 'tenant-a',
      }).success,
    ).toBe(true);
    expect(userSeed.safeParse({}).success).toBe(false);
  });
});

describe('storageObjectSeed', () => {
  it('requires path and contentBase64, and accepts an optional contentType', () => {
    expect(
      storageObjectSeed.safeParse({ path: 'uploads/pic.png', contentBase64: 'aGk=' }).success,
    ).toBe(true);
    expect(storageObjectSeed.safeParse({ path: 'uploads/pic.png' }).success).toBe(false);
  });
});

describe('checkUserFields', () => {
  it('suggests customClaims for the client spelling claims', () => {
    const rejection = checkUserFields({ users: [{ uid: 'a', claims: { role: 'owner' } }] }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('users.claims');
    expect(rejection?.summary).toContain("'customClaims'");
  });

  it('suggests tenantId for the client spelling tenant', () => {
    const rejection = checkUserFields({ users: [{ uid: 'a', tenant: 'tenant-a' }] }, fail);
    expect(rejection?.summary).toContain("'tenantId'");
  });

  it('rejects a field with no rename and no close match, naming the accepted set', () => {
    const rejection = checkUserFields(
      { users: [{ uid: 'a', nonexistentField: 1 }] },
      fail,
    );
    expect(rejection).not.toBeNull();
    expect(rejection?.data.fix).toContain("Remove 'nonexistentField'");
  });

  it('passes users entries built only from the accepted fields', () => {
    expect(
      checkUserFields(
        { users: [{ uid: 'a', email: 'a@example.com', customClaims: {}, tenantId: 't' }] },
        fail,
      ),
    ).toBeNull();
  });

  it('does not check when users is absent or not an array', () => {
    expect(checkUserFields({}, fail)).toBeNull();
    expect(checkUserFields({ users: 'nope' }, fail)).toBeNull();
  });
});

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
