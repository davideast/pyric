/**
 * The branch methods of the `sandbox` tool, held to what they claim.
 *
 * Each of these checks the world rather than the return value: the files on
 * disk after a fork, the live snapshot after an apply, the promoted document
 * read back through the surface, and the snapshot hash after every read. A
 * method that reported success while changing nothing, or changed the live
 * sandbox while claiming to work on a branch, fails here.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { BRANCH_STORE_RELATIVE, loadBranch, saveBranch } from 'pyric/sandbox/branches/store';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';
import { applyData, applyRules, type SandboxSeed } from '../../../../../src/bridge/surface/seed-apply.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const CLOSED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

const surface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

/** Call one method through its service tool, the way the product does. */
async function run(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

/** A stable string for the live Firestore keyspace, so a change to it is visible. */
function liveHash(): string {
  return JSON.stringify(sandbox.snapshot().firestore);
}

/** The bytes of one branch's stored base snapshot. */
function baseBytes(name: string): string {
  return readFileSync(join(projectDir, BRANCH_STORE_RELATIVE, name, 'base.bundle.json'), 'utf8');
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-branch-methods-'));
  sandbox = initializeSandbox();
  setRules(sandbox, OPEN_RULES);
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** The event log shape a recorded session carries, planted rather than captured. */
function writeEvent(path: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'write',
    method: 'set',
    path,
    data,
    auth: null,
    requestTime: { seconds: 1_700_000_000, nanoseconds: 0 },
  };
}

describe('sandbox.fork', () => {
  it('stores the branch and leaves the live sandbox alone', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    const before = liveHash();

    const forked = await run('sandbox.fork', { branch: 'draft' });
    expect(forked.ok).toBe(true);
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft', 'manifest.json'))).toBe(true);
    expect(liveHash()).toBe(before);
  });

  it('reports a later live write as a divergence without changing the stored base', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    await run('sandbox.fork', { branch: 'draft' });
    const storedBase = baseBytes('draft');

    await run('firestore.setDoc', { path: 'notes/n2', data: { body: 'after the fork' } });

    const diffed = await run('sandbox.diff', { branch: 'draft' });
    expect(diffed.ok).toBe(true);
    const paths = (diffed.data as { divergences: Array<{ path: string }> }).divergences.map(
      (entry) => entry.path,
    );
    expect(paths).toContain('notes/n2');
    expect(baseBytes('draft')).toBe(storedBase);
  });

  it('refuses a second fork under a name the project already holds', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const again = await run('sandbox.fork', { branch: 'draft' });
    expect(again.ok).toBe(false);
    expect(again.summary).toContain('draft');
  });

  it('applies candidate rules to the branch and not to the live sandbox', async () => {
    const forked = await run('sandbox.fork', {
      branch: 'locked',
      candidateRules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`,
    });
    expect(forked.ok).toBe(true);
    const written = await run('firestore.setDoc', { path: 'notes/live', data: { body: 'ok' } });
    expect(written.ok).toBe(true);
  });
});

describe('sandbox.apply', () => {
  it('changes the branch on disk and not the live sandbox', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const before = liveHash();

    const applied = await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/planted', { body: 'from the plan' })],
    });
    expect(applied.ok).toBe(true);
    expect(liveHash()).toBe(before);
    expect(sandbox.snapshot().firestore['notes/planted']).toBeUndefined();

    const manifest = JSON.parse(
      readFileSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft', 'manifest.json'), 'utf8'),
    ) as { eventCount: number };
    expect(manifest.eventCount).toBe(1);

    const diffed = await run('sandbox.diff', { branch: 'draft' });
    const paths = (diffed.data as { divergences: Array<{ path: string }> }).divergences.map(
      (entry) => entry.path,
    );
    expect(paths).toContain('notes/planted');
  });

  it('reads the events of a recorded session named by path', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    mkdirSync(join(projectDir, '.pyric'), { recursive: true });
    writeFileSync(
      join(projectDir, '.pyric', 'last-session.json'),
      JSON.stringify({ events: [writeEvent('notes/recorded', { body: 'replayed' })] }),
    );

    const applied = await run('sandbox.apply', {
      branch: 'draft',
      sessionPath: '.pyric/last-session.json',
    });
    expect(applied.ok).toBe(true);

    const diffed = await run('sandbox.diff', { branch: 'draft' });
    const paths = (diffed.data as { divergences: Array<{ path: string }> }).divergences.map(
      (entry) => entry.path,
    );
    expect(paths).toContain('notes/recorded');
  });

  it('refuses a call that names neither events nor a session, naming both options', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const refused = await run('sandbox.apply', { branch: 'draft' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('events');
    expect(refused.summary).toContain('sessionPath');
  });

  it('refuses a call that names both events and a session', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const refused = await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/a', { body: 'a' })],
      sessionPath: '.pyric/last-session.json',
    });
    expect(refused.ok).toBe(false);
  });

  it('refuses a session path that leaves the project directory', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const refused = await run('sandbox.apply', {
      branch: 'draft',
      sessionPath: '../outside.json',
    });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('project');
  });
});

describe('sandbox.diff', () => {
  it('reports a divergence planted between a checkpoint and a branch', async () => {
    await run('firestore.setDoc', { path: 'notes/kept', data: { body: 'shared' } });
    const saved = await run('sandbox.checkpoint', { name: 'nightly' });
    expect(saved.ok).toBe(true);

    await run('firestore.setDoc', { path: 'notes/planted', data: { body: 'after' } });
    await run('sandbox.fork', { branch: 'draft' });

    const diffed = await run('sandbox.diff', { branch: 'draft', against: 'nightly' });
    expect(diffed.ok).toBe(true);
    const paths = (diffed.data as { divergences: Array<{ path: string }> }).divergences.map(
      (entry) => entry.path,
    );
    expect(paths).toContain('notes/planted');
    expect(paths).not.toContain('notes/kept');
  });

  it('refuses a checkpoint name the project does not hold', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    const refused = await run('sandbox.diff', { branch: 'draft', against: 'nightly' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('nightly');
  });

  it('names the checkpoints that do exist when the named one does not', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.checkpoint', { name: 'before-migration' });

    const refused = await run('sandbox.diff', { branch: 'draft', against: 'nightly' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('before-migration');
  });
});

describe('sandbox.promote', () => {
  it('lands the branch on the live sandbox and removes the branch directory', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/promoted', { body: 'landed' })],
    });

    const promoted = await run('sandbox.promote', { branch: 'draft', confirm: true });
    expect(promoted.ok).toBe(true);

    const read = await run('firestore.getDoc', { path: 'notes/promoted' });
    expect(read.ok).toBe(true);
    expect((read.data as { data: { body: string } }).data.body).toBe('landed');
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'))).toBe(false);
  });

  it('rolls the live sandbox back and keeps the branch when a write is refused', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [
        writeEvent('notes/landed', { body: 'first' }),
        writeEvent('notes/refused', { body: 'second' }),
      ],
    });
    const before = liveHash();

    // A write the live admin plane will not take, planted so the promotion
    // fails after it has already landed one document.
    const env = getInternalEnv(sandbox) as unknown as {
      adminSetDocument: (path: string, data: Record<string, unknown>) => void;
    };
    const accepted = env.adminSetDocument.bind(env);
    env.adminSetDocument = (path, data) => {
      if (path === 'notes/refused') throw new Error('the admin plane refused this write');
      accepted(path, data);
    };

    const promoted = await run('sandbox.promote', { branch: 'draft', confirm: true });
    env.adminSetDocument = accepted;

    expect(promoted.ok).toBe(false);
    expect(promoted.summary).toContain('draft');
    expect(liveHash()).toBe(before);
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'))).toBe(true);
  });

  it('is refused without confirm, and the branch and the live sandbox are untouched', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/pending', { body: 'not yet' })],
    });
    const before = liveHash();

    const refused = await run('sandbox.promote', { branch: 'draft' });
    expect(refused.ok).toBe(false);
    expect((refused.data as { field?: string }).field).toBe('confirm');
    expect(liveHash()).toBe(before);
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'))).toBe(true);
  });
});

describe('sandbox.discard', () => {
  it('removes the directory and leaves the live sandbox byte identical', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/never', { body: 'discarded' })],
    });
    const before = liveHash();

    const discarded = await run('sandbox.discard', { branch: 'draft' });
    expect(discarded.ok).toBe(true);
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'draft'))).toBe(false);
    expect(liveHash()).toBe(before);
  });

  it('refuses a branch the project does not hold', async () => {
    const refused = await run('sandbox.discard', { branch: 'absent' });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('absent');
  });
});

describe('sandbox.listBranches', () => {
  it('reports each stored branch with its created time, event count, and divergences', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/planted', { body: 'planned' })],
    });

    const listed = await run('sandbox.listBranches');
    expect(listed.ok).toBe(true);
    const branches = (
      listed.data as {
        branches: Array<{
          name: string;
          created: string;
          base: string;
          eventCount: number;
          divergences: number;
        }>;
      }
    ).branches;
    expect(branches).toHaveLength(1);
    expect(branches[0]!.name).toBe('draft');
    expect(branches[0]!.base).toBe('live');
    expect(branches[0]!.eventCount).toBe(1);
    expect(branches[0]!.divergences).toBeGreaterThan(0);
    expect(typeof branches[0]!.created).toBe('string');
  });

  it('reports nothing for a project that holds no branches', async () => {
    const listed = await run('sandbox.listBranches');
    expect(listed.ok).toBe(true);
    expect((listed.data as { branches: unknown[] }).branches).toEqual([]);
  });
});

describe('the read methods', () => {
  it('leave the live snapshot hash unchanged', async () => {
    await run('firestore.setDoc', { path: 'notes/n1', data: { body: 'live' } });
    await run('sandbox.fork', { branch: 'draft' });
    await run('sandbox.apply', {
      branch: 'draft',
      events: [writeEvent('notes/planted', { body: 'planned' })],
    });
    const before = liveHash();

    await run('sandbox.diff', { branch: 'draft' });
    await run('sandbox.listBranches');
    expect(liveHash()).toBe(before);
  });
});

/**
 * A branch carries every service, so a divergence in any one of them has to
 * reach `diff` under that service's name and land on live through `promote`.
 * The plant goes straight onto the branch's own sandbox through the same seed
 * the surface applies to live, because no tool method writes to a branch
 * outside Firestore, and the read back goes through each service's own tool
 * method rather than through the branch store.
 */
async function plantOnBranch(name: string, seed: SandboxSeed): Promise<void> {
  const loaded = await loadBranch(projectDir, name);
  if (loaded === null) throw new Error(`no branch named ${name}`);
  await applyRules(loaded.branch.sandbox, seed);
  await applyData(loaded.branch.sandbox, seed);
  await saveBranch(projectDir, name, loaded.branch, {
    base: loaded.manifest.base,
    created: loaded.manifest.created,
  });
  loaded.branch.sandbox.dispose();
}

/** The services a diff named, deduplicated, in the order it reported them. */
function servicesOf(result: OperationResult): string[] {
  const divergences = (result.data as { divergences: Array<{ service: string }> }).divergences;
  return [...new Set(divergences.map((entry) => entry.service))];
}

describe('the branch methods across every service', () => {
  it('names firestore in the diff and lands the document on live', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await plantOnBranch('draft', { firestore: { 'notes/planted': { body: 'from the branch' } } });

    expect(servicesOf(await run('sandbox.diff', { branch: 'draft' }))).toContain('firestore');

    expect((await run('sandbox.promote', { branch: 'draft', confirm: true })).ok).toBe(true);
    const read = await run('firestore.getDoc', { path: 'notes/planted' });
    expect((read.data as { data: { body: string } }).data.body).toBe('from the branch');
  });

  it('names database in the diff and lands the value on live', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await plantOnBranch('draft', { database: { rooms: { one: { title: 'from the branch' } } } });

    expect(servicesOf(await run('sandbox.diff', { branch: 'draft' }))).toContain('database');

    expect((await run('sandbox.promote', { branch: 'draft', confirm: true })).ok).toBe(true);
    const read = await run('database.get', { path: 'rooms/one' });
    expect((read.data as { value: { title: string } }).value.title).toBe('from the branch');
  });

  it('names storage in the diff and lands the object on live', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await plantOnBranch('draft', {
      storage: [
        {
          path: 'docs/planted.txt',
          contentBase64: 'aGVsbG8=',
          contentType: 'text/plain',
          customMetadata: { owner: 'the branch' },
        },
      ],
    });

    expect(servicesOf(await run('sandbox.diff', { branch: 'draft' }))).toContain('storage');

    expect((await run('sandbox.promote', { branch: 'draft', confirm: true })).ok).toBe(true);
    const read = await run('storage.getMetadata', { path: 'docs/planted.txt' });
    expect(read.ok).toBe(true);
    expect((read.data as { customMetadata: Record<string, string> }).customMetadata.owner).toBe(
      'the branch',
    );
  });

  it('names auth in the diff and lands the account on live', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await plantOnBranch('draft', {
      users: [{ uid: 'planted', email: 'planted@example.com', customClaims: { role: 'editor' } }],
    });

    expect(servicesOf(await run('sandbox.diff', { branch: 'draft' }))).toContain('auth');

    expect((await run('sandbox.promote', { branch: 'draft', confirm: true })).ok).toBe(true);
    const read = await run('auth.getUser', { uid: 'planted' });
    expect(read.ok).toBe(true);
    expect((read.data as { user: { email: string } }).user.email).toBe('planted@example.com');
  });

  it('names rules in the diff and lands the candidate ruleset on live', async () => {
    await run('sandbox.fork', { branch: 'locked', candidateRules: { firestore: CLOSED_RULES } });

    expect(servicesOf(await run('sandbox.diff', { branch: 'locked' }))).toContain('rules');

    expect((await run('sandbox.promote', { branch: 'locked', confirm: true })).ok).toBe(true);
    const linted = await run('rules.lint', { service: 'firestore' });
    expect(linted.ok).toBe(true);
    expect(JSON.stringify(linted.data)).toContain('never');
  });

  it('counts the divergences of each service in the summary', async () => {
    await run('sandbox.fork', { branch: 'draft' });
    await plantOnBranch('draft', {
      firestore: { 'notes/planted': { body: 'a' } },
      users: [{ uid: 'planted' }],
    });

    const diffed = await run('sandbox.diff', { branch: 'draft' });
    expect(diffed.summary).toContain('firestore');
    expect(diffed.summary).toContain('auth');
    const counts = (diffed.data as { counts: Record<string, number> }).counts;
    expect(counts.firestore).toBeGreaterThan(0);
    expect(counts.auth).toBeGreaterThan(0);
  });

  it('accepts candidateRules as a string of Firestore rules', async () => {
    const forked = await run('sandbox.fork', { branch: 'locked', candidateRules: CLOSED_RULES });
    expect(forked.ok).toBe(true);
    expect(servicesOf(await run('sandbox.diff', { branch: 'locked' }))).toContain('rules');
  });
});
